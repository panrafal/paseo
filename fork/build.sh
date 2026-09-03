#!/usr/bin/env bash
#
# fork/build.sh — build the fork. Nothing else: it never starts a daemon,
# installs a launcher, or writes a config. Each command ends by handing you
# the one command to run on your own machine to pick the build up.
#
# Commands:
#   fork/build.sh daemon     build + pack the daemon and CLI for this devbox
#   fork/build.sh desktop    tag a fork build; Actions builds the macOS app
#   fork/build.sh vscode     package the VS Code extension for laptop + devbox
#   fork/build.sh ios        EAS build + TestFlight submit
#   fork/build.sh all        every build above, then one command to install all
#
# Flags:
#   --sync         run fork/sync.sh first
#   --clean        wipe node_modules and dist before building
#
# The build lives in its own checkout ($FORK_WORK_ROOT/build) so node_modules
# survives between builds and nothing here touches the checkout you work in.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=fork/config.sh
. "$HERE/config.sh"
set -a
# shellcheck source=fork/dist.env
. "$HERE/dist.env"
set +a

cmd=""
do_sync=0 do_clean=0
for arg in "$@"; do
  case "$arg" in
    daemon | desktop | vscode | ios | all) cmd="$arg" ;;
    --sync) do_sync=1 ;;
    --clean) do_clean=1 ;;
    -h | --help)
      sed -n '3,19p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown argument: $arg" ;;
  esac
done
[ -n "$cmd" ] || die "pick one of: daemon, desktop, vscode, ios, all (see --help)"

require_repo
[ "$do_sync" -eq 0 ] || "$HERE/sync.sh" --rebase --agent --push

# The install command each build ends with; `all` folds them into one.
DAEMON_INSTALL="" DESKTOP_INSTALL="" VSCODE_INSTALL="" IOS_INSTALL=""
BUILT=()

# ------------------------------------------------------------- checkout ----

CHECKOUT_READY=0
prepare_checkout() {
  # `all` runs several builds against the one checkout; prepare it once.
  [ "$CHECKOUT_READY" -eq 0 ] || return 0

  git rev-parse --verify -q "$TARGET^{commit}" >/dev/null ||
    die "branch '$TARGET' does not exist — run fork/sync.sh first"
  local sha
  sha="$(git rev-parse "$TARGET")"

  mkdir -p "$WORK_ROOT"
  if [ ! -e "$BUILD_DIR/.git" ]; then
    rm -rf "$BUILD_DIR"
    git worktree prune
    say "Creating build checkout at $BUILD_DIR"
    git worktree add --detach "$BUILD_DIR" "$sha" >/dev/null
  else
    # Detached, so sync.sh can force-move `main` underneath us freely.
    git -C "$BUILD_DIR" checkout --detach --force "$sha" >/dev/null 2>&1
    git -C "$BUILD_DIR" clean -fdq -e node_modules -e '**/node_modules' -e '**/dist'
  fi

  if [ "$do_clean" -eq 1 ]; then
    say "Cleaning node_modules and dist"
    (cd "$BUILD_DIR" &&
      find . -maxdepth 3 -name node_modules -type d -prune -exec rm -rf {} + 2>/dev/null || true
      find packages -maxdepth 2 -name dist -type d -prune -exec rm -rf {} + 2>/dev/null || true)
  fi

  say "Building $(git -C "$BUILD_DIR" log -1 --format='%h %s')"
  (cd "$BUILD_DIR" && npm install --no-audit --no-fund)
  CHECKOUT_READY=1
}

# Stamp the fork version AFTER npm install, so the install still resolves
# against the committed lockfile, and before anything is packed, so every
# artifact and the @getpaseo/* cross-dependency ranges carry it. The build
# checkout is disposable; prepare_checkout force-resets it on the next run.
VERSION=""
stamp_version() {
  [ -z "$VERSION" ] || return 0
  VERSION="$(fork_version)"
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
# is not published anywhere, so the update is "install these tarballs".

# Publish order matters: a dependency has to be on disk before the package
# that requires it resolves against it.
PACKAGES=(highlight relay protocol client plugin server cli)

build_daemon() {
  prepare_checkout
  stamp_version

  # Only the daemon's own tarballs go: the VS Code build parks its .vsix in
  # the same directory.
  mkdir -p "$DIST_DIR"
  rm -f "$DIST_DIR"/getpaseo-*.tgz
  local args=()
  for p in "${PACKAGES[@]}"; do args+=("--workspace=@getpaseo/$p"); done

  # Each package's prepack does its own clean build, so this packs and builds
  # in one pass.
  say "Packing ${#PACKAGES[@]} workspaces (this builds them)"
  (cd "$BUILD_DIR" && npm pack "${args[@]}" --pack-destination "$DIST_DIR" >/dev/null)

  local packed count
  packed="$(node -pe 'require(process.argv[1]).version' "$BUILD_DIR/packages/cli/package.json")"
  [ "$packed" = "$VERSION" ] || die "expected packed version $VERSION, got $packed"
  count="$(find "$DIST_DIR" -name '*.tgz' | wc -l | tr -d ' ')"
  [ "$count" -eq "${#PACKAGES[@]}" ] ||
    die "expected ${#PACKAGES[@]} tarballs in $DIST_DIR, found $count"
  say "Packed $count tarballs for $VERSION in $DIST_DIR"
  BUILT+=(daemon)

  # Brace expansion keeps the seven paths readable. It is expanded by the
  # login shell on the far side, so devbox-admin needs bash or zsh, not dash.
  # The order is dependency-first: npm has to see a package on disk before the
  # one that requires it.
  local list
  list="$(
    IFS=,
    echo "${PACKAGES[*]}"
  )"
  DAEMON_INSTALL="ssh $FORK_DEVBOX_SSH \"sudo npm install -g --prefix $FORK_DEVBOX_NPM_PREFIX --allow-scripts=esbuild,node-pty \\
  $DIST_DIR/getpaseo-{$list}-$VERSION.tgz \\
  && sudo systemctl restart $FORK_DEVBOX_SERVICE && sleep $FORK_DEVBOX_SETTLE && $FORK_DEVBOX_HEALTHCHECK\""
  offer_command "Run this on your laptop to update the devbox daemon:" "$DAEMON_INSTALL"
  daemon_restart_warning
}

daemon_restart_warning() {
  echo "Restarting the service drops every running agent on this machine,"
  echo "including any that is watching you paste it."
}

# -------------------------------------------------------------- desktop ----
# macOS cannot be cross-built from here, so the desktop build is a tag that
# starts the Fork Desktop workflow on a macOS runner.

build_desktop() {
  # release.sh waits for the workflow. A red run fails here, and `all` then
  # leaves the desktop out of the combined command rather than stopping.
  "$HERE/release.sh" desktop || return 1
  # update-macos.sh is fetched rather than copied, so the Mac always runs the
  # version that matches the build it is about to install.
  DESKTOP_INSTALL="gh api repos/$FORK_GH_OWNER/$FORK_GH_REPO/contents/fork/update-macos.sh?ref=$TARGET -H 'Accept: application/vnd.github.raw' | bash"
  BUILT+=(desktop)
  offer_command "Run this on your Mac:" "$DESKTOP_INSTALL"
}

# --------------------------------------------------------------- vscode ----
# packages/vscode arrives through the vscode patch branch; without it there is
# nothing to package, which is a skip so that `all` can always run this step.
# The printed command installs on the laptop and on this host — see
# fork/install-vscode-remote.sh for why the devbox needs its own install.

build_vscode() {
  prepare_checkout
  if [ ! -f "$BUILD_DIR/packages/vscode/package.json" ]; then
    warn "no packages/vscode in $TARGET — the vscode branch is not merged, nothing to build"
    return 0
  fi
  stamp_version

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
  # The installer travels with the .vsix: $HERE may be a worktree that is gone
  # by the time the command is pasted.
  local installer="$DIST_DIR/install-vscode-remote.sh"
  cp "$HERE/install-vscode-remote.sh" "$installer"
  say "Packaged $vsix"
  BUILT+=(vscode)

  # `sudo cat` rather than scp: $DIST_DIR is under a home directory the admin
  # account cannot read. The devbox half runs as the account the editors SSH
  # in as, because that is whose ~/.vscode-server and ~/.cursor-server it is.
  local laptop_vsix="/tmp/paseo-vscode-$VERSION.vsix"
  VSCODE_INSTALL="ssh $FORK_DEVBOX_SSH \"sudo cat $vsix\" > $laptop_vsix \\
  && for c in code cursor; do command -v \$c >/dev/null || continue; \$c --install-extension $laptop_vsix --force; done \\
  && ssh $FORK_DEVBOX_SSH \"sudo -u $FORK_DEVBOX_EDITOR_USER -H $installer $vsix\""
  offer_command "Run this on your laptop to install it into VS Code and Cursor, there and on the devbox:" "$VSCODE_INSTALL"
  echo "Devbox half only, from a terminal here:"
  echo "    $installer $vsix"
  echo "Open remote windows pick it up after Developer: Reload Window."
}

# ------------------------------------------------------------------ ios ----

build_ios() {
  prepare_checkout
  "$HERE/ios.sh" ship
  IOS_INSTALL="open 'itms-beta://beta.itunes.apple.com/v1/app/$FORK_ASC_APP_ID'"
  BUILT+=(ios)
  offer_command "The build is in TestFlight; install it on the phone with:" "$IOS_INSTALL"
}

# fork/ios.sh refuses to run with placeholders or blanks in fork/dist.env.
# `all` asks first, so an unconfigured iOS is a skip, not the end of the run.
ios_configured() {
  local var
  for var in FORK_IOS_BUNDLE_ID FORK_EAS_OWNER FORK_EAS_PROJECT_ID FORK_ASC_APP_ID FORK_APPLE_TEAM_ID; do
    case "${!var}" in
      REPLACE_ME* | "") return 1 ;;
    esac
  done
  return 0
}

# ------------------------------------------------------------------ all ----
# Every build in turn, then the install commands folded into one. The daemon
# goes last there: its restart drops every agent on this machine, so nothing
# that still needs the old daemon may come after it.

build_all() {
  build_daemon
  build_desktop || warn "the desktop build failed — leaving it out of the combined command"
  build_vscode
  if ios_configured; then
    build_ios
  else
    warn "iOS is not set up (fork/dist.env has placeholders or blanks) — skipping"
  fi

  local step joined=""
  for step in "$DESKTOP_INSTALL" "$VSCODE_INSTALL" "$IOS_INSTALL" "$DAEMON_INSTALL"; do
    [ -n "$step" ] || continue
    if [ -z "$joined" ]; then
      joined="$step"
    else
      joined="$joined \\
&& $step"
    fi
  done

  say "Built $VERSION: ${BUILT[*]:-nothing}"
  offer_command "Run this on your laptop to install all of it (the daemon last):" "$joined"
  daemon_restart_warning
}

case "$cmd" in
  daemon) build_daemon ;;
  desktop) build_desktop ;;
  vscode) build_vscode ;;
  ios) build_ios ;;
  all) build_all ;;
esac
