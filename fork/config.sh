# Shared settings for the fork/ scripts. Override any of these in the
# environment; nothing here is machine-specific.

# Where upstream and your fork live.
UPSTREAM_REMOTE="${FORK_UPSTREAM_REMOTE:-upstream}"
UPSTREAM_BRANCH="${FORK_UPSTREAM_BRANCH:-main}"
FORK_REMOTE="${FORK_REMOTE:-origin}"

# The base branch (this directory, plus the fork's own identity) and the
# integration branch it builds. The integration branch is this fork's `main`:
# a clone of the fork is meant to give you the batteries-included build, and
# upstream's workflows only fire on a branch literally called `main`, so `main`
# has to be the branch that carries fork-base's disabled/ workflow move.
TOOLING_REF="${FORK_TOOLING_REF:-fork-base}"
TARGET="${FORK_TARGET_BRANCH:-main}"

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
# Run after the restart to confirm the new daemon actually came up. The pause
# is there because systemd returns as soon as the unit is started, not when the
# daemon is serving.
FORK_DEVBOX_SETTLE="${FORK_DEVBOX_SETTLE:-8}"
FORK_DEVBOX_HEALTHCHECK="${FORK_DEVBOX_HEALTHCHECK:-sudo devbox-healthcheck}"
# The devbox account VS Code and Cursor SSH in as. The VS Code extension goes
# into that account's ~/.vscode-server and ~/.cursor-server, which the build
# reaches through FORK_DEVBOX_SSH and sudo. Defaults to whoever runs the build.
FORK_DEVBOX_EDITOR_USER="${FORK_DEVBOX_EDITOR_USER:-$(id -un)}"

# Fork identity lives in fork/dist.env; config.sh only needs the owner for
# version stamping, so default it and let dist.env override.
FORK_GH_OWNER="${FORK_GH_OWNER:-panrafal}"

# Agent used by `--agent` conflict resolution.
FORK_AGENT_PROVIDER="${FORK_AGENT_PROVIDER:-claude}"
FORK_AGENT_TIMEOUT="${FORK_AGENT_TIMEOUT:-45m}"

# Where this directory is, resolved from config.sh itself so the secret helper
# below finds fork/.env.fork no matter which directory a script is run from.
FORK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FORK_ENV_FILE="${FORK_ENV_FILE:-$FORK_DIR/.env.fork}"
FORK_DOTENVX_VERSION="${FORK_DOTENVX_VERSION:-2}"

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

# ------------------------------------------------------------- secrets ----
# The fork's own secrets — today just EXPO_TOKEN, which fork/ios.sh hands to
# `eas` — live encrypted in fork/.env.fork, committed on the tooling branch.
# The private key that opens it never is: dotenvx keeps it in a .env.keys that
# .gitignore covers at every depth, or you export DOTENV_PRIVATE_KEY_FORK.
#
# Apple's signing secrets are not here. Those are GitHub repo secrets, because
# the thing that needs them is a workflow; EXPO_TOKEN is here because the thing
# that needs it is a script on this machine.

# `dotenvx set -f fork/.env.fork` writes .env.keys to the working directory,
# but `dotenvx run` looks for it next to the env file. So the key can be in
# either place depending on where you ran `set`, and neither survives a git
# worktree, which gets its own checkout of a gitignored file — that is, none.
# All three are offered; dotenvx takes the first that opens the file.
fork_key_files() {
  printf '%s\n' \
    "$FORK_DIR/.env.keys" \
    "$(dirname "$FORK_DIR")/.env.keys" \
    "$WORK_ROOT/.env.keys"
}

# Decrypted values can only reach a script that has already started by way of
# a new process, so this re-execs its caller under `dotenvx run`. The guard is
# exported: the re-exec, and anything it spawns — including ios.sh running
# `"$0" build` — passes straight through on the second visit.
#
# Call it as `load_fork_secrets "$HERE/thescript.sh" "$@"`, guarded by a test
# for the variable you actually need, so an already-exported value wins and no
# key is demanded for a run that does not need one.
load_fork_secrets() {
  local script="$1"
  shift

  [ -z "${FORK_SECRETS_LOADED:-}" ] || return 0
  export FORK_SECRETS_LOADED=1

  if [ ! -f "$FORK_ENV_FILE" ]; then
    warn "no $FORK_ENV_FILE — secrets have to come from the environment. See fork/README.md."
    return 0
  fi

  local key_file have_key=0
  local keys=()
  while IFS= read -r key_file; do
    [ -f "$key_file" ] || continue
    have_key=1
    keys+=(-fk "$key_file")
  done < <(fork_key_files)

  if [ "$have_key" -eq 0 ] && [ -z "${DOTENV_PRIVATE_KEY_FORK:-}" ]; then
    die "$FORK_ENV_FILE is encrypted and nothing here can open it.
Put the private key in one of:
$(fork_key_files | sed 's/^/  /')
or export DOTENV_PRIVATE_KEY_FORK. It is printed by \`dotenvx keypair\` and
should also be in your password manager. See fork/README.md."
  fi

  # Prefer a dotenvx on PATH; npx is the fallback so this never has to be a
  # dependency of the repo — package.json and the lockfile churn on every sync.
  local runner=(npx --yes "@dotenvx/dotenvx@$FORK_DOTENVX_VERSION")
  if command -v dotenvx >/dev/null 2>&1; then
    runner=(dotenvx)
  fi

  # --strict matters: without it a key that cannot decrypt is a warning on
  # stderr and an exit status of 0, and the ciphertext is handed to `eas` as
  # if it were the token.
  exec "${runner[@]}" run -f "$FORK_ENV_FILE" ${keys[@]+"${keys[@]}"} --strict -- "$script" "$@"
}

# The fork version, shared by every artifact so a daemon, a desktop app and a
# TestFlight build from the same commit all report the same string.
#
#   0.7.2-panrafal.7
#   ^upstream base   ^fork build number
#
# fork/build-number lives on the base branch and holds both halves —
# "0.7.2 7" — because the counter restarts at 1 every time the upstream
# version moves. Storing the version it was counting for is what makes the
# restart detectable; a bare integer cannot tell "first build of 0.7.3" from
# "someone reset the file".
#
# The restart is safe, but only under that exact rule — reset when the base
# moves, never otherwise. Two things depend on it:
#
#   - The desktop updater compares semver, and 0.7.3-panrafal.1 sorts above
#     0.7.2-panrafal.99 because the base dominates. A restart is still an
#     upgrade.
#   - App Store Connect requires CFBundleVersion to increase within one
#     CFBundleShortVersionString. native-release-version.js reports the bare
#     base as the short version, so the restart lands exactly when that string
#     changes. Restarting the counter while the base held would be rejected.
#
# The number is bumped once per sync, after the rebase and before anything is
# merged, so it is committed into the `main` commit it identifies.
fork_version() {
  local ref="${1:-$TARGET}" base number
  base="$(git show "$ref:package.json" |
    node -pe 'JSON.parse(require("node:fs").readFileSync(0, "utf8")).version')"
  number="$(fork_build_number "$ref" "$base")"
  echo "$base-panrafal.$number"
}

fork_build_number() {
  local ref="${1:-$TARGET}" expect_base="${2:-}" stored_base number
  read -r stored_base number < <(git show "$ref:fork/build-number" 2>/dev/null)
  [ -n "$number" ] || die "no fork/build-number on $ref — run fork/sync.sh first"
  if [ -n "$expect_base" ] && [ "$stored_base" != "$expect_base" ]; then
    die "fork/build-number on $ref counts $stored_base, but package.json says $expect_base — run fork/sync.sh"
  fi
  echo "$number"
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
