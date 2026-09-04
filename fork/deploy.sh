#!/usr/bin/env bash
#
# fork/deploy.sh — build every fork target and install each one where it
# runs. Run it on the laptop.
#
#   fork/deploy.sh                 all four targets
#   fork/deploy.sh vscode daemon   only these
#
# Flags:
#   --no-update    build what main is at now, without resetting it to origin
#   --clean        wipe node_modules and dist in the build checkouts first
#
# First main is reset to origin/main, here and on the devbox, so every target
# comes from the same commit. Then, all at once:
#
#   daemon    built on the devbox over ssh, installed there with npm, the
#             service restarted, the healthcheck run
#   desktop   tagged from here; GitHub Actions builds the macOS app; installed
#             here with fork/update-macos.sh, which relaunches it
#   vscode    built here; the .vsix installed into VS Code and Cursor here and
#             into their servers on the devbox
#   ios       EAS build queued from here; it submits itself to TestFlight
#
# One target failing does not stop the others. Each target's output goes to
# $FORK_WORK_ROOT/deploy/<target>.log, and the summary at the end says what
# was built, where it was installed, and what failed.
#
# It has to run off the devbox: installing the desktop app needs macOS, and
# restarting the daemon kills every agent on the devbox, including one that
# would be running this.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=fork/config.sh
. "$HERE/config.sh"
set -a
# shellcheck source=fork/dist.env
. "$HERE/dist.env"
set +a

[ "${BASH_VERSINFO[0]}" -ge 4 ] || die "bash 4 or newer is required (brew install bash)"

ALL=(daemon desktop vscode ios)
targets=()
update=1 clean=0 job=""
while [ $# -gt 0 ]; do
  case "$1" in
    daemon | desktop | vscode | ios) targets+=("$1") ;;
    all) targets=("${ALL[@]}") ;;
    --no-update) update=0 ;;
    --clean) clean=1 ;;
    --job) # internal: run one target in this process, see the run section
      job="$2"
      shift
      ;;
    -h | --help)
      sed -n '3,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done
[ "${#targets[@]}" -gt 0 ] || targets=("${ALL[@]}")

wants() {
  local t
  for t in "${targets[@]}"; do [ "$t" = "$1" ] && return 0; done
  return 1
}

require_repo
REPO="$FORK_GH_OWNER/$FORK_GH_REPO"

# ------------------------------------------------------------- helpers ----

# Single-quote a string for a remote shell.
sq() { printf "'%s'" "${1//\'/\'\\\'\'}"; }

# Run a command on the devbox as the admin account, or as the account that
# owns the repo checkout, the build directory and the editors' server installs.
devbox_admin() { ssh -o BatchMode=yes "$FORK_DEVBOX_SSH" "$@"; }
devbox_user() {
  ssh -o BatchMode=yes "$FORK_DEVBOX_SSH" "sudo -u $FORK_DEVBOX_USER -H bash -lc $(sq "$1")"
}

# One line per thing a job did, kept in its result file so the summary can
# say how far a failed job got.
note() {
  echo "$*" >>"$RESULT_FILE"
  say "$*"
}

# ----------------------------------------------------------------- jobs ----
# Each job runs as a separate process of this script (--job <target>), so a
# failing step ends that job under set -e and nothing else.

job_daemon() {
  local flags=""
  [ "$clean" -eq 0 ] || flags=" --clean"
  devbox_user "cd $(sq "$FORK_DEVBOX_REPO") && fork/build.sh daemon$flags"
  note "built on the devbox into $FORK_DEVBOX_WORK_ROOT/dist"
  local p tarballs=()
  for p in "${FORK_DAEMON_PACKAGES[@]}"; do
    tarballs+=("$FORK_DEVBOX_WORK_ROOT/dist/getpaseo-$p-$VERSION.tgz")
  done
  # --allow-scripts: npm blocks install scripts by default, and without them
  # esbuild and node-pty install unconfigured.
  devbox_admin "sudo npm install -g --prefix $FORK_DEVBOX_NPM_PREFIX --allow-scripts=esbuild,node-pty ${tarballs[*]}"
  note "installed into $FORK_DEVBOX_NPM_PREFIX on the devbox"
  # systemctl returns as soon as the unit is started, not when the daemon is
  # serving; the pause is for the healthcheck.
  devbox_admin "sudo systemctl restart $FORK_DEVBOX_SERVICE && sleep $FORK_DEVBOX_SETTLE && $FORK_DEVBOX_HEALTHCHECK"
  note "service $FORK_DEVBOX_SERVICE restarted, healthcheck passed"
}

job_desktop() {
  local tag="fork-v$VERSION"
  if gh release view "$tag" --repo "$REPO" >/dev/null 2>&1; then
    note "release $tag already exists — not building it again"
  else
    "$HERE/build.sh" desktop
    note "built by GitHub Actions: https://github.com/$REPO/releases/tag/$tag"
  fi
  "$HERE/update-macos.sh" "$tag"
  note "installed /Applications/Paseo.app and relaunched it"
}

# The local checkout was prepared — and, with --clean, wiped — once by the
# parent before the jobs started; passing --clean on here would wipe it
# again underneath the ios job that shares it.
job_vscode() {
  "$HERE/build.sh" vscode
  local vsix="$DIST_DIR/paseo-vscode-$VERSION.vsix"
  if [ ! -f "$vsix" ]; then
    note "nothing to install: $TARGET has no packages/vscode"
    return 0
  fi
  note "built $vsix"
  local editor
  for editor in code cursor; do
    if ! command -v "$editor" >/dev/null 2>&1; then
      note "$editor is not on PATH here — skipped"
      continue
    fi
    "$editor" --install-extension "$vsix" --force
    note "installed into $editor here"
  done
  # The servers' extensions live in the editor account's home on the devbox.
  # The installer travels with the .vsix, from main, so the two agree.
  local remote_vsix="/tmp/paseo-vscode-$VERSION.vsix" remote_installer="/tmp/paseo-install-vscode-remote.sh"
  local out="$DEPLOY_DIR/vscode-devbox.log" line rc=0
  devbox_admin "cat >$remote_vsix" <"$vsix"
  git show "$TARGET:fork/install-vscode-remote.sh" |
    devbox_admin "cat >$remote_installer && chmod +x $remote_installer"
  # The installer's output is kept for the notes; it is shown, and the notes
  # taken, whether or not it failed, so a failure says why.
  devbox_admin "sudo -u $FORK_DEVBOX_EDITOR_USER -H $remote_installer $remote_vsix" >"$out" 2>&1 || rc=$?
  cat "$out"
  while IFS= read -r line; do
    case "$line" in
      installed:* | skipped:*) note "devbox: ${line#*: }" ;;
    esac
  done <"$out"
  [ "$rc" -eq 0 ] || return "$rc"
}

job_ios() {
  local var
  for var in FORK_IOS_BUNDLE_ID FORK_EAS_OWNER FORK_EAS_PROJECT_ID FORK_ASC_APP_ID FORK_APPLE_TEAM_ID; do
    case "${!var}" in
      REPLACE_ME* | "")
        note "skipped: $var is not set in fork/dist.env"
        return 0
        ;;
    esac
  done
  "$HERE/build.sh" ios --no-wait
  local url
  url="$(grep -oE 'https://expo\.dev/[^ ]+/builds/[^ ]+' "$LOG_FILE" | head -1 || true)"
  note "EAS build queued${url:+: $url}; it submits itself to TestFlight when done"
}

if [ -n "$job" ]; then
  VERSION="$(fork_version)"
  RESULT_FILE="$DEPLOY_DIR/$job.result"
  LOG_FILE="$DEPLOY_DIR/$job.log"
  "job_$job"
  exit 0
fi

# ------------------------------------------------------------ preflight ----

if wants desktop && [ "$(uname -s)" != "Darwin" ]; then
  die "the desktop target installs into /Applications, so this has to run on the Mac. Pick the other targets, or run it there."
fi
if wants desktop; then
  command -v gh >/dev/null 2>&1 || die "the gh CLI is required: brew install gh"
fi
if wants vscode || wants ios; then
  command -v node >/dev/null 2>&1 || die "node is required to build here"
fi
if wants daemon || wants vscode; then
  devbox_admin true >/dev/null 2>&1 ||
    die "cannot reach the devbox as $FORK_DEVBOX_SSH — is this the laptop, with the ssh alias set up?"
fi

# ---------------------------------------------------------- main = origin ----
# Nothing is built from a local main. It is reset to origin/main here and on
# the devbox; a main checkout with uncommitted changes stops the deploy.

reset_main_here() {
  git fetch -q "$FORK_REMOTE" "$TARGET"
  local wt
  wt="$(git worktree list --porcelain |
    awk -v b="refs/heads/$TARGET" '/^worktree /{p=$2} /^branch /{if ($2==b) {print p; exit}}')"
  if [ -n "$wt" ]; then
    [ -z "$(git -C "$wt" status --porcelain --untracked-files=no)" ] ||
      die "$TARGET is checked out with local changes in $wt — commit or clear them first"
    git -C "$wt" reset -q --hard "$FORK_REMOTE/$TARGET"
  else
    git branch -q -f "$TARGET" "$FORK_REMOTE/$TARGET"
  fi
}

# The same on the devbox, as the account that owns the checkout. The script
# is assembled here and single-quoted for the remote shell.
remote_reset_script() {
  cat <<SCRIPT
cd $(sq "$FORK_DEVBOX_REPO") &&
git fetch -q $(sq "$FORK_REMOTE") $(sq "$TARGET") &&
if [ "\$(git symbolic-ref -q --short HEAD)" = $(sq "$TARGET") ]; then
  [ -z "\$(git status --porcelain --untracked-files=no)" ] || { echo $(sq "$TARGET checkout is dirty") >&2; exit 1; }
  git reset -q --hard $(sq "$FORK_REMOTE/$TARGET")
else
  git branch -q -f $(sq "$TARGET") $(sq "$FORK_REMOTE/$TARGET")
fi &&
git rev-parse $(sq "$TARGET")
SCRIPT
}

reset_main_devbox() {
  local remote_sha
  remote_sha="$(devbox_user "$(remote_reset_script)")" ||
    die "could not reset $TARGET on the devbox ($FORK_DEVBOX_REPO)"
  assert_same_main "$remote_sha" "is $FORK_DEVBOX_REPO pointed at the same remote?"
}

# The daemon is built from the devbox's own main and installed under the
# version this main carries, so the two have to be the same commit.
check_main_devbox() {
  local remote_sha
  remote_sha="$(devbox_user "cd $(sq "$FORK_DEVBOX_REPO") && git rev-parse $(sq "$TARGET")")" ||
    die "cannot read $TARGET on the devbox ($FORK_DEVBOX_REPO)"
  assert_same_main "$remote_sha" "drop --no-update, or reset the devbox checkout"
}

assert_same_main() {
  local remote_sha="$1" hint="$2"
  [ "$remote_sha" = "$(git rev-parse "$TARGET")" ] ||
    die "the devbox's $TARGET is $remote_sha but ours is $(git rev-parse "$TARGET") — $hint"
}

if [ "$update" -eq 1 ]; then
  say "Resetting $TARGET to $FORK_REMOTE/$TARGET here"
  reset_main_here
  if wants daemon || wants vscode; then
    say "Resetting $TARGET to $FORK_REMOTE/$TARGET on the devbox"
    reset_main_devbox
  fi
elif wants daemon; then
  check_main_devbox
fi

VERSION="$(fork_version)"
say "Deploying $VERSION from $(git log -1 --format='%h %s' "$TARGET")"

mkdir -p "$DEPLOY_DIR"
rm -f "$DEPLOY_DIR"/*.log "$DEPLOY_DIR"/*.result "$DEPLOY_DIR"/*.exit

# The local build checkout is shared by vscode and ios; prepare it once, up
# front, rather than have both jobs race to npm install into it.
if wants vscode || wants ios; then
  if [ "$clean" -eq 1 ]; then
    "$HERE/build.sh" prepare --clean
  else
    "$HERE/build.sh" prepare
  fi
fi

# ------------------------------------------------------------------ run ----

flags=()
[ "$clean" -eq 0 ] || flags+=(--clean)
declare -A EXIT_FILES=()
for t in "${targets[@]}"; do
  : >"$DEPLOY_DIR/$t.log"
  : >"$DEPLOY_DIR/$t.result"
  (
    set +e
    "$0" --job "$t" ${flags[@]+"${flags[@]}"} >"$DEPLOY_DIR/$t.log" 2>&1
    echo $? >"$DEPLOY_DIR/$t.exit"
  ) &
  EXIT_FILES[$t]="$DEPLOY_DIR/$t.exit"
  say "$t: started — log: $DEPLOY_DIR/$t.log"
done

# Jobs report through their exit files; a process table check cannot tell a
# finished job from one waiting to be reaped.
declare -A STATUS=()
while [ "${#EXIT_FILES[@]}" -gt 0 ]; do
  for t in "${!EXIT_FILES[@]}"; do
    [ -s "${EXIT_FILES[$t]}" ] || continue
    STATUS[$t]="$(cat "${EXIT_FILES[$t]}")"
    unset "EXIT_FILES[$t]"
    if [ "${STATUS[$t]}" = 0 ]; then
      say "$t: done"
    else
      warn "$t: failed (exit ${STATUS[$t]}) — see $DEPLOY_DIR/$t.log"
    fi
  done
  [ "${#EXIT_FILES[@]}" -eq 0 ] || sleep 3
done
wait

# -------------------------------------------------------------- summary ----

failed=0
echo
say "Deploy of $VERSION"
for t in "${targets[@]}"; do
  if [ "${STATUS[$t]}" = 0 ]; then
    printf '  \033[32m%-8s\033[0m ok\n' "$t"
  else
    failed=1
    printf '  \033[31m%-8s\033[0m FAILED (exit %s) — %s\n' "$t" "${STATUS[$t]}" "$DEPLOY_DIR/$t.log"
  fi
  sed 's/^/           /' "$DEPLOY_DIR/$t.result"
  [ "${STATUS[$t]}" = 0 ] || printf '           stopped after the last line above\n'
done
[ "$failed" -eq 0 ] || exit 1
