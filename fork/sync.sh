#!/usr/bin/env bash
#
# fork/sync.sh — rebuild the `panrafal` integration branch.
#
#   panrafal = upstream/main + fork-tooling + every ref in fork/branches
#
# The branch is rebuilt from scratch every run, so it is always exactly
# "latest upstream plus my patches" with no accumulated merge cruft. That
# means the result is a new history each time and the push is a force-push.
#
# Usage:
#   fork/sync.sh              build locally, print the push command
#   fork/sync.sh --push       build and force-push to origin/panrafal
#   fork/sync.sh --no-fetch   skip fetching (use the refs you already have)
#
# Environment overrides: FORK_UPSTREAM_REMOTE, FORK_UPSTREAM_BRANCH,
# FORK_REMOTE, FORK_TOOLING_REF, FORK_TARGET_BRANCH.
#
# Run it from any worktree of this repo; it builds in a scratch worktree and
# never touches your checkout.

set -euo pipefail

UPSTREAM_REMOTE="${FORK_UPSTREAM_REMOTE:-upstream}"
UPSTREAM_BRANCH="${FORK_UPSTREAM_BRANCH:-main}"
FORK_REMOTE="${FORK_REMOTE:-origin}"
TOOLING_REF="${FORK_TOOLING_REF:-fork-tooling}"
TARGET="${FORK_TARGET_BRANCH:-panrafal}"

push=0
fetch=1
for arg in "$@"; do
  case "$arg" in
    --push) push=1 ;;
    --no-fetch) fetch=0 ;;
    -h | --help)
      sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "fork/sync.sh: unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
die() {
  printf '\033[31merror:\033[0m %s\n' "$*" >&2
  exit 1
}

git rev-parse --git-dir >/dev/null 2>&1 || die "not inside a git repository"
COMMON_DIR="$(git rev-parse --path-format=absolute --git-common-dir)"
BUILD_DIR="$COMMON_DIR/fork-sync"

git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1 ||
  die "remote '$UPSTREAM_REMOTE' is missing. Add it:
  git remote add $UPSTREAM_REMOTE https://github.com/getpaseo/paseo.git"

# Conflict resolutions are remembered and replayed, so a conflict between
# upstream and one of your patches is hand-resolved once, not every sync.
[ "$(git config --get rerere.enabled || true)" = "true" ] ||
  git config rerere.enabled true
[ "$(git config --get rerere.autoupdate || true)" = "true" ] ||
  git config rerere.autoupdate true

# A left-over build worktree means the previous run stopped on a conflict.
if [ -e "$BUILD_DIR" ]; then
  if git -C "$BUILD_DIR" rev-parse --verify -q MERGE_HEAD >/dev/null 2>&1; then
    die "a previous sync stopped on a conflict in:
  $BUILD_DIR
Finish it (git -C '$BUILD_DIR' status), or throw it away:
  git worktree remove --force '$BUILD_DIR'"
  fi
  git worktree remove --force "$BUILD_DIR" >/dev/null 2>&1 || true
fi
git worktree prune

if [ "$fetch" -eq 1 ]; then
  say "Fetching $UPSTREAM_REMOTE and $FORK_REMOTE"
  git fetch --prune "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH"
  git fetch --prune "$FORK_REMOTE"
fi

BASE="$UPSTREAM_REMOTE/$UPSTREAM_BRANCH"
git rev-parse --verify -q "$BASE^{commit}" >/dev/null || die "cannot resolve $BASE"

git rev-parse --verify -q "$TOOLING_REF^{commit}" >/dev/null ||
  die "tooling branch '$TOOLING_REF' not found — it holds fork/branches and this script"

# Read the branch list from the tooling ref, not the working tree, so the
# script behaves the same no matter which branch you invoke it from.
mapfile -t REFS < <(
  git show "$TOOLING_REF:fork/branches" |
    sed -e 's/#.*//' -e 's/[[:space:]]*$//' -e '/^$/d'
)

MERGE_REFS=("$TOOLING_REF" ${REFS[@]+"${REFS[@]}"})
for ref in "${MERGE_REFS[@]}"; do
  git rev-parse --verify -q "$ref^{commit}" >/dev/null ||
    die "cannot resolve '$ref' (listed in fork/branches on $TOOLING_REF)"
done

say "Base: $BASE ($(git log -1 --format='%h %s' "$BASE"))"

git worktree add --detach "$BUILD_DIR" "$BASE" >/dev/null
trap 'git worktree remove --force "$BUILD_DIR" >/dev/null 2>&1 || true' EXIT

for ref in "${MERGE_REFS[@]}"; do
  short="$(git log -1 --format='%h' "$ref")"
  if git -C "$BUILD_DIR" merge --no-ff --no-edit \
    -m "Merge $ref into $TARGET" "$ref" >/dev/null 2>&1; then
    say "merged $ref ($short)"
    continue
  fi
  # rerere may have replayed a stored resolution; if nothing is left
  # unmerged, just commit and carry on.
  if [ -z "$(git -C "$BUILD_DIR" diff --name-only --diff-filter=U)" ]; then
    git -C "$BUILD_DIR" commit --no-edit >/dev/null
    say "merged $ref ($short) — conflict replayed from rerere"
    continue
  fi
  trap - EXIT
  printf '\033[31mconflict\033[0m merging %s:\n' "$ref" >&2
  git -C "$BUILD_DIR" diff --name-only --diff-filter=U | sed 's/^/  /' >&2
  cat >&2 <<EOF

Resolve it in the build worktree, then re-run this script:

  cd $BUILD_DIR
  # edit, then:
  git add -A && git commit --no-edit
  cd - && fork/sync.sh

The resolution is recorded by rerere and replayed on future syncs.
To abandon instead: git worktree remove --force '$BUILD_DIR'
EOF
  exit 1
done

RESULT="$(git -C "$BUILD_DIR" rev-parse HEAD)"

# Move the branch. If it is checked out somewhere, update that worktree too.
WT_PATH="$(git worktree list --porcelain |
  awk -v b="refs/heads/$TARGET" '
    /^worktree /{p=$2} /^branch /{if ($2==b) {print p; exit}}')"
if [ -n "$WT_PATH" ]; then
  [ -z "$(git -C "$WT_PATH" status --porcelain)" ] ||
    die "$TARGET is checked out with local changes in $WT_PATH — commit or clear them, then re-run"
  git -C "$WT_PATH" reset --hard "$RESULT" >/dev/null
  say "reset worktree $WT_PATH to the new $TARGET"
else
  git branch -f "$TARGET" "$RESULT"
fi

git worktree remove --force "$BUILD_DIR" >/dev/null 2>&1 || true
trap - EXIT

say "$TARGET is now $(git log -1 --format='%h' "$TARGET") = $BASE + ${#MERGE_REFS[@]} branches"
git log --oneline --first-parent -n "$((${#MERGE_REFS[@]} + 1))" "$TARGET" | sed 's/^/    /'

if [ "$push" -eq 1 ]; then
  say "Force-pushing to $FORK_REMOTE/$TARGET"
  git push --force-with-lease "$FORK_REMOTE" "$TARGET:$TARGET"
else
  echo
  echo "Not pushed. To publish:"
  echo "    git push --force-with-lease $FORK_REMOTE $TARGET:$TARGET"
  echo "  or re-run with --push."
fi
