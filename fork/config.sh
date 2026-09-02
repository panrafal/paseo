# Shared settings for the fork/ scripts. Override any of these in the
# environment; nothing here is machine-specific.

# Where upstream and your fork live.
UPSTREAM_REMOTE="${FORK_UPSTREAM_REMOTE:-upstream}"
UPSTREAM_BRANCH="${FORK_UPSTREAM_BRANCH:-main}"
FORK_REMOTE="${FORK_REMOTE:-origin}"

# The tooling branch (this directory) and the integration branch it builds.
TOOLING_REF="${FORK_TOOLING_REF:-fork-tooling}"
TARGET="${FORK_TARGET_BRANCH:-panrafal}"

# Scratch, build and artifact directories. Kept outside the repo so they
# survive rebuilds and out of `.git/` so agents can be pointed at them.
WORK_ROOT="${FORK_WORK_ROOT:-$HOME/.paseo-fork}"
SYNC_DIR="$WORK_ROOT/sync"     # throwaway merge worktree
BUILD_DIR="$WORK_ROOT/build"   # persistent build checkout (keeps node_modules)
DIST_DIR="$WORK_ROOT/dist"     # packed npm tarballs

# How the laptop reaches this machine to install a daemon build. The scripts
# never run these themselves; they print the command for you to paste.
FORK_DEVBOX_SSH="${FORK_DEVBOX_SSH:-devbox-admin}"
FORK_DEVBOX_NPM_PREFIX="${FORK_DEVBOX_NPM_PREFIX:-/usr}"
FORK_DEVBOX_SERVICE="${FORK_DEVBOX_SERVICE:-paseo}"

# Fork identity lives in fork/dist.env; config.sh only needs the owner for
# version stamping, so default it and let dist.env override.
FORK_GH_OWNER="${FORK_GH_OWNER:-panrafal}"

# Agent used by `--agent` conflict resolution.
FORK_AGENT_PROVIDER="${FORK_AGENT_PROVIDER:-claude}"
FORK_AGENT_TIMEOUT="${FORK_AGENT_TIMEOUT:-45m}"

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[31merror:\033[0m %s\n' "$*" >&2
  exit 1
}

# Print the command to paste locally, and push it to the terminal's clipboard
# with OSC 52 so it can be pasted without selecting it. Terminals that do not
# support OSC 52 ignore the sequence, so the printed block is the contract.
offer_command() {
  local label="$1" command="$2"
  printf '\n\033[1m%s\033[0m\n' "$label"
  printf '\033[36m%s\033[0m\n\n' "$command"
  if [ -t 1 ]; then
    printf '\033]52;c;%s\a' "$(printf '%s' "$command" | base64 | tr -d '\n')"
    printf '(copied to your clipboard, if the terminal allows it)\n'
  fi
}

# The fork version, shared by every artifact so a daemon, a desktop app and a
# TestFlight build from the same commit all report the same string.
#
#   0.7.2-FR07a
#   ^base   ^commit
#
# The FR prefix is not decoration: it keeps the prerelease identifier
# alphanumeric. A bare sha like 076 would be an all-numeric identifier with a
# leading zero, which semver forbids and npm rejects outright.
#
# One consequence worth knowing: this does not sort. Semver compares FR07a
# against FRb51 lexically, so roughly half of all updates look like downgrades
# and the desktop's in-app updater cannot be relied on to offer a fork build.
# fork/update-macos.sh installs by release recency instead and is unaffected.
# Three hex characters is also 4096 values, so commits eventually collide; that
# surfaces as `git tag` refusing a duplicate in fork/release.sh, which is loud
# and recoverable rather than silent.
fork_version() {
  local ref="${1:-$TARGET}" base sha
  base="$(git show "$ref:package.json" |
    node -pe 'JSON.parse(require("node:fs").readFileSync(0, "utf8")).version')"
  sha="$(git rev-parse "$ref")"
  echo "$base-FR${sha:0:3}"
}

# App Store Connect requires CFBundleVersion to increase with every upload for
# a given CFBundleShortVersionString, and a 3-character sha cannot carry that.
# The commit timestamp can, and it stays out of the version string.
fork_ios_build_number() {
  TZ=UTC git log -1 --date=format:%Y%m%d%H%M --format=%cd "${1:-$TARGET}"
}

require_repo() {
  git rev-parse --git-dir >/dev/null 2>&1 || die "not inside a git repository"
  git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1 ||
    die "remote '$UPSTREAM_REMOTE' is missing. Add it:
  git remote add $UPSTREAM_REMOTE https://github.com/getpaseo/paseo.git"
}

# Read the branch list from the tooling ref rather than the working tree, so
# the scripts behave the same no matter which branch you invoke them from.
read_branch_list() {
  git show "$TOOLING_REF:fork/branches" |
    sed -e 's/#.*//' -e 's/[[:space:]]*$//' -e '/^$/d'
}
