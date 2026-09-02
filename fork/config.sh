# Shared settings for fork/sync.sh and fork/build.sh.
# Override any of these in the environment; nothing here is machine-specific.

# Where upstream and your fork live.
UPSTREAM_REMOTE="${FORK_UPSTREAM_REMOTE:-upstream}"
UPSTREAM_BRANCH="${FORK_UPSTREAM_BRANCH:-main}"
FORK_REMOTE="${FORK_REMOTE:-origin}"

# The tooling branch (this directory) and the integration branch it builds.
TOOLING_REF="${FORK_TOOLING_REF:-fork-tooling}"
TARGET="${FORK_TARGET_BRANCH:-panrafal}"

# Scratch and build checkouts. Kept outside the repo so they survive rebuilds
# and out of `.git/` so agents can be pointed at them.
WORK_ROOT="${FORK_WORK_ROOT:-$HOME/.paseo-fork}"
SYNC_DIR="$WORK_ROOT/sync"     # throwaway merge worktree
BUILD_DIR="$WORK_ROOT/build"   # persistent build checkout (keeps node_modules)

# The side-by-side daemon fork/build.sh installs on this machine.
FORK_PASEO_HOME="${FORK_PASEO_HOME:-$HOME/.paseo-fork/home}"
FORK_PASEO_LISTEN="${FORK_PASEO_LISTEN:-127.0.0.1:6866}"
FORK_BIN_DIR="${FORK_BIN_DIR:-$HOME/.local/bin}"

# Agent used by `--agent` conflict resolution.
FORK_AGENT_PROVIDER="${FORK_AGENT_PROVIDER:-claude}"
FORK_AGENT_TIMEOUT="${FORK_AGENT_TIMEOUT:-45m}"

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[31merror:\033[0m %s\n' "$*" >&2
  exit 1
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
