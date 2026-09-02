#!/usr/bin/env bash
#
# fork/build.sh — build the fork. Nothing else: it never starts a daemon,
# installs a launcher, or writes a config. Each command ends by handing you
# the one command to run on your own machine to pick the build up.
#
# Commands:
#   fork/build.sh daemon     build + pack the daemon and CLI for this devbox
#   fork/build.sh desktop    tag a fork build; Actions builds the macOS app
#   fork/build.sh ios        EAS build + TestFlight submit
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
    daemon | desktop | ios) cmd="$arg" ;;
    --sync) do_sync=1 ;;
    --clean) do_clean=1 ;;
    -h | --help)
      sed -n '3,18p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown argument: $arg" ;;
  esac
done
[ -n "$cmd" ] || die "pick one of: daemon, desktop, ios (see --help)"

require_repo
[ "$do_sync" -eq 0 ] || "$HERE/sync.sh" --rebase --agent --push

# ------------------------------------------------------------- checkout ----

prepare_checkout() {
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
    # Detached, so sync.sh can force-move `panrafal` underneath us freely.
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
}

# --------------------------------------------------------------- daemon ----
# The devbox runs the daemon from a global npm install driven by systemd. It
# is not published anywhere, so the update is "install these tarballs".

# Publish order matters: a dependency has to be on disk before the package
# that requires it resolves against it.
PACKAGES=(highlight relay protocol client plugin server cli)

build_daemon() {
  prepare_checkout

  rm -rf "$DIST_DIR"
  mkdir -p "$DIST_DIR"
  local args=()
  for p in "${PACKAGES[@]}"; do args+=("--workspace=@getpaseo/$p"); done

  # Each package's prepack does its own clean build, so this packs and builds
  # in one pass.
  say "Packing ${#PACKAGES[@]} workspaces (this builds them)"
  (cd "$BUILD_DIR" && npm pack "${args[@]}" --pack-destination "$DIST_DIR" >/dev/null)

  local version count
  version="$(node -pe 'require(process.argv[1]).version' "$BUILD_DIR/packages/cli/package.json")"
  count="$(find "$DIST_DIR" -name '*.tgz' | wc -l | tr -d ' ')"
  [ "$count" -eq "${#PACKAGES[@]}" ] ||
    die "expected ${#PACKAGES[@]} tarballs in $DIST_DIR, found $count"
  say "Packed $count tarballs for $version in $DIST_DIR"

  local tarballs
  tarballs="$(for p in "${PACKAGES[@]}"; do printf '%s ' "$DIST_DIR/getpaseo-$p-$version.tgz"; done)"
  offer_command "Run this on your laptop to update the devbox daemon:" \
    "ssh $FORK_DEVBOX_SSH \"sudo npm install -g --prefix $FORK_DEVBOX_NPM_PREFIX --allow-scripts=esbuild,node-pty ${tarballs% } && sudo systemctl restart $FORK_DEVBOX_SERVICE\""
  echo "Restarting the service drops every running agent on this machine,"
  echo "including any that is watching you paste it."
}

# -------------------------------------------------------------- desktop ----
# macOS cannot be cross-built from here, so the desktop build is a tag that
# starts the Fork Desktop workflow on a macOS runner.

build_desktop() {
  "$HERE/release.sh" desktop
  # update-macos.sh is fetched rather than copied, so the Mac always runs the
  # version that matches the build it is about to install.
  offer_command "Run this on your Mac once the workflow finishes:" \
    "gh api repos/$FORK_GH_OWNER/$FORK_GH_REPO/contents/fork/update-macos.sh?ref=$TARGET -H 'Accept: application/vnd.github.raw' | bash"
}

# ------------------------------------------------------------------ ios ----

build_ios() {
  prepare_checkout
  "$HERE/ios.sh" ship
  offer_command "The build is in TestFlight; install it on the phone with:" \
    "open 'itms-beta://beta.itunes.apple.com/v1/app/$FORK_ASC_APP_ID'"
}

case "$cmd" in
  daemon) build_daemon ;;
  desktop) build_desktop ;;
  ios) build_ios ;;
esac
