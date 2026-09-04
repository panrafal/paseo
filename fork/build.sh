#!/usr/bin/env bash
#
# fork/build.sh — build the fork. Nothing else: it never installs, restarts
# or launches anything. fork/deploy.sh is what puts a build where it runs.
#
# Commands:
#   fork/build.sh prepare    check main out into the build checkout, install
#                            dependencies, stamp the fork version
#   fork/build.sh daemon     build + pack the daemon and CLI into ~/.paseo-fork/dist
#   fork/build.sh desktop    tag a fork build; Actions builds and releases the macOS app
#   fork/build.sh vscode     package the VS Code extension into ~/.paseo-fork/dist
#   fork/build.sh ios        EAS iOS build; it submits itself to TestFlight
#
# Flags:
#   --clean      wipe node_modules and dist before building
#   --no-wait    ios: return as soon as the EAS build is queued
#
# The build lives in its own checkout ($FORK_WORK_ROOT/build) so node_modules
# survives between builds and nothing here touches the checkout you work in.
# `prepare` happens once per main commit; daemon, vscode and ios do it if
# needed, and once it is done they can run at the same time. desktop builds
# nothing here: it publishes main and a tag, and GitHub Actions does the rest.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=fork/config.sh
. "$HERE/config.sh"
set -a
# shellcheck source=fork/dist.env
. "$HERE/dist.env"
set +a

cmd=""
do_clean=0 no_wait=0
for arg in "$@"; do
  case "$arg" in
    prepare | daemon | desktop | vscode | ios) cmd="$arg" ;;
    --clean) do_clean=1 ;;
    --no-wait) no_wait=1 ;;
    -h | --help)
      sed -n '3,21p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown argument: $arg" ;;
  esac
done
[ -n "$cmd" ] || die "pick one of: prepare, daemon, desktop, vscode, ios (see --help)"

require_repo

# ------------------------------------------------------------- checkout ----

# The checkout is prepared once per main commit and shared by every build
# after that. The marker records which commit it was prepared for; the lock
# keeps two builds started at once from both running npm install into it.
PREPARED_MARKER="$BUILD_DIR/.fork-prepared"
PREPARE_LOCK="$WORK_ROOT/build.lock"

prepare_checkout() {
  git rev-parse --verify -q "$TARGET^{commit}" >/dev/null ||
    die "branch '$TARGET' does not exist — run fork/integrate.sh rebuild first"
  local sha
  sha="$(git rev-parse "$TARGET")"

  mkdir -p "$WORK_ROOT"
  local waited=0
  while ! mkdir "$PREPARE_LOCK" 2>/dev/null; do
    [ "$waited" -eq 0 ] && say "Waiting for another build to finish preparing $BUILD_DIR"
    waited=$((waited + 1))
    [ "$waited" -lt 300 ] || die "gave up waiting for $PREPARE_LOCK — remove it if no build is running"
    sleep 2
  done
  trap 'rmdir "$PREPARE_LOCK" 2>/dev/null || true' EXIT

  if [ "$do_clean" -eq 0 ] && [ "$(cat "$PREPARED_MARKER" 2>/dev/null || true)" = "$sha" ]; then
    say "Build checkout is ready at $(git -C "$BUILD_DIR" log -1 --format='%h %s')"
  else
    rm -f "$PREPARED_MARKER"
    if [ ! -e "$BUILD_DIR/.git" ]; then
      rm -rf "$BUILD_DIR"
      git worktree prune
      say "Creating build checkout at $BUILD_DIR"
      git worktree add --detach "$BUILD_DIR" "$sha" >/dev/null
    else
      # Detached, so integrate.sh can move `main` underneath us freely.
      git -C "$BUILD_DIR" checkout --detach --force "$sha" >/dev/null 2>&1
      git -C "$BUILD_DIR" clean -fdq -e node_modules -e '**/node_modules' -e '**/dist'
    fi

    if [ "$do_clean" -eq 1 ]; then
      say "Cleaning node_modules and dist"
      (cd "$BUILD_DIR" &&
        find . -maxdepth 3 -name node_modules -type d -prune -exec rm -rf {} + 2>/dev/null || true
        find packages -maxdepth 2 -name dist -type d -prune -exec rm -rf {} + 2>/dev/null || true)
    fi

    say "Preparing $(git -C "$BUILD_DIR" log -1 --format='%h %s')"
    (cd "$BUILD_DIR" && npm install --no-audit --no-fund)
    echo "$sha" >"$PREPARED_MARKER"
  fi
  stamp_version
  rmdir "$PREPARE_LOCK" 2>/dev/null || true
  trap - EXIT
}

# Stamp the fork version AFTER npm install, so the install still resolves
# against the committed lockfile, and before anything is packed, so every
# artifact and the @getpaseo/* cross-dependency ranges carry it. Already
# stamped is a no-op, so parallel builds sharing the checkout do not race.
VERSION=""
stamp_version() {
  VERSION="$(fork_version)"
  [ "$(node -pe 'require(process.argv[1]).version' "$BUILD_DIR/package.json")" != "$VERSION" ] || return 0
  say "Stamping $VERSION"
  node -e '
    const fs = require("node:fs");
    const p = process.argv[1];
    const pkg = JSON.parse(fs.readFileSync(p, "utf8"));
    pkg.version = process.argv[2];
    fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + "\n");
  ' "$BUILD_DIR/package.json" "$VERSION"
  (cd "$BUILD_DIR" && node scripts/sync-workspace-versions.mjs >/dev/null)
}

# --------------------------------------------------------------- daemon ----
# The devbox runs the daemon from a global npm install driven by systemd. It
# is not published anywhere, so the artifact is a set of tarballs.

build_daemon() {
  prepare_checkout

  # Only the daemon's own tarballs go: the VS Code build parks its .vsix in
  # the same directory.
  mkdir -p "$DIST_DIR"
  rm -f "$DIST_DIR"/getpaseo-*.tgz
  local p args=()
  for p in "${FORK_DAEMON_PACKAGES[@]}"; do args+=("--workspace=@getpaseo/$p"); done

  # Each package's prepack does its own clean build, so this packs and builds
  # in one pass.
  say "Packing ${#FORK_DAEMON_PACKAGES[@]} workspaces (this builds them)"
  (cd "$BUILD_DIR" && npm pack "${args[@]}" --pack-destination "$DIST_DIR" >/dev/null)

  local packed count
  packed="$(node -pe 'require(process.argv[1]).version' "$BUILD_DIR/packages/cli/package.json")"
  [ "$packed" = "$VERSION" ] || die "expected packed version $VERSION, got $packed"
  count="$(find "$DIST_DIR" -name '*.tgz' | wc -l | tr -d ' ')"
  [ "$count" -eq "${#FORK_DAEMON_PACKAGES[@]}" ] ||
    die "expected ${#FORK_DAEMON_PACKAGES[@]} tarballs in $DIST_DIR, found $count"
  say "Packed $count tarballs for $VERSION in $DIST_DIR"
}

# -------------------------------------------------------------- desktop ----
# macOS cannot be cross-built from here, so the desktop build is a tag that
# starts the Fork Desktop workflow on a macOS runner. release.sh waits for
# the run; a red run fails this command.

build_desktop() {
  "$HERE/release.sh" desktop
}

# --------------------------------------------------------------- vscode ----
# packages/vscode arrives through the vscode patch branch; without it there is
# nothing to package, which is a skip rather than a failure.

build_vscode() {
  prepare_checkout
  if [ ! -f "$BUILD_DIR/packages/vscode/package.json" ]; then
    warn "no packages/vscode in $TARGET — the vscode branch is not merged, nothing to build"
    return 0
  fi

  say "Building the VS Code extension (web app export + vsce package)"
  (cd "$BUILD_DIR" && npm run build:vscode >/dev/null)

  local packed vsix
  packed="$(node -pe 'require(process.argv[1]).version' "$BUILD_DIR/packages/vscode/package.json")"
  [ "$packed" = "$VERSION" ] || die "expected extension version $VERSION, got $packed"
  [ -s "$BUILD_DIR/packages/vscode/paseo.vsix" ] ||
    die "npm run build:vscode left no packages/vscode/paseo.vsix behind"
  mkdir -p "$DIST_DIR"
  rm -f "$DIST_DIR"/paseo-vscode-*.vsix
  vsix="$DIST_DIR/paseo-vscode-$VERSION.vsix"
  cp "$BUILD_DIR/packages/vscode/paseo.vsix" "$vsix"
  say "Packaged $vsix"
}

# ------------------------------------------------------------------ ios ----

build_ios() {
  prepare_checkout
  if [ "$no_wait" -eq 1 ]; then
    "$HERE/ios.sh" trigger
  else
    "$HERE/ios.sh" ship
  fi
}

case "$cmd" in
  prepare) prepare_checkout ;;
  daemon) build_daemon ;;
  desktop) build_desktop ;;
  vscode) build_vscode ;;
  ios) build_ios ;;
esac
