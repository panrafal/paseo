#!/usr/bin/env bash
#
# fork/sync.sh — rebuild the integration branch.
#
#   main = upstream/main + fork-base + every ref in fork/branches
#
# The branch is rebuilt from scratch every run, so it is always exactly
# "latest upstream plus my patches" with no accumulated merge cruft. The
# result is a new history each time, so publishing it is a force-push.
#
# Usage:
#   fork/sync.sh                 rebuild locally, print the push command
#   fork/sync.sh --push          rebuild and force-push to origin/main
#   fork/sync.sh --agent         hand merge conflicts to a Paseo agent
#   fork/sync.sh --rebase        also rebase each feature branch onto upstream
#   fork/sync.sh --no-fetch      use the refs already fetched
#
# See fork/README.md. Settings live in fork/config.sh.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=fork/config.sh
. "$HERE/config.sh"

push=0 fetch=1 use_agent=0 do_rebase=0
for arg in "$@"; do
  case "$arg" in
    --push) push=1 ;;
    --agent) use_agent=1 ;;
    --rebase) do_rebase=1 ;;
    --no-fetch) fetch=0 ;;
    -h | --help)
      sed -n '3,19p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "unknown argument: $arg" ;;
  esac
done

require_repo

# Conflict resolutions are remembered and replayed, so a collision between
# upstream and one of your patches is hand-resolved once, not every sync.
[ "$(git config --get rerere.enabled || true)" = "true" ] || git config rerere.enabled true
[ "$(git config --get rerere.autoupdate || true)" = "true" ] || git config rerere.autoupdate true

# The build number identifies the commit this sync is about to produce, so it
# has to be committed to the base branch before that branch is merged. Run it
# after the rebase: fork-base is rebased onto upstream/main like any other
# branch now, and a rebase would replay or drop a bump committed before it.
#
# fork/build-number holds the upstream version the counter belongs to and the
# counter itself ("0.7.2 13"). The counter restarts at 1 whenever the upstream
# version moves — see fork_version() in config.sh for why that is safe.
bump_build_number() {
  local dir="$WORK_ROOT/bump" stored_base stored_number base next sha
  rm -rf "$dir"
  git worktree prune
  git worktree add --detach "$dir" "$TOOLING_REF" >/dev/null
  read -r stored_base stored_number <<<"$(cat "$dir/fork/build-number" 2>/dev/null)"
  # Read the version off upstream, not off the base branch's worktree: the
  # counter belongs to the upstream release this build is made from, and
  # without --rebase the base branch can still be sitting on an older one.
  base="$(git show "$BASE:package.json" |
    node -pe 'JSON.parse(require("node:fs").readFileSync(0, "utf8")).version')"
  if [ "$stored_base" = "$base" ] && [ -n "$stored_number" ]; then
    next=$((stored_number + 1))
  else
    next=1
    [ -z "$stored_base" ] || say "upstream is now $base — restarting the fork counter"
  fi
  echo "$base $next" >"$dir/fork/build-number"
  git -C "$dir" add fork/build-number
  git -C "$dir" -c core.hooksPath=/dev/null commit -q -m "fork: build $base-panrafal.$next"
  sha="$(git -C "$dir" rev-parse HEAD)"
  git worktree remove --force "$dir" >/dev/null 2>&1 || true
  move_branch "$TOOLING_REF" "$sha"
  # --force-with-lease everywhere, including here where the push is normally a
  # fast-forward: if another machine or agent bumped the number since the last
  # fetch, the lease fails instead of quietly reusing or overwriting a build id.
  [ "$push" -eq 0 ] ||
    git push -q --force-with-lease "$FORK_REMOTE" "$TOOLING_REF:$TOOLING_REF"
  say "Build $base-panrafal.$next"
}

# `git branch -f` refuses to move a branch that is checked out somewhere, and
# both patch branches and the target routinely are. Move the worktree instead.
move_branch() {
  local branch="$1" sha="$2" wt
  wt="$(git worktree list --porcelain |
    awk -v b="refs/heads/$branch" '
      /^worktree /{p=$2} /^branch /{if ($2==b) {print p; exit}}')"
  if [ -z "$wt" ]; then
    git branch -f "$branch" "$sha"
    return
  fi
  [ -z "$(git -C "$wt" status --porcelain)" ] ||
    die "$branch is checked out with local changes in $wt — commit or clear them, then re-run"
  git -C "$wt" reset --hard "$sha" >/dev/null
  say "reset worktree $wt to the new $branch"
}

# Every branch in fork/branches is meant to live directly on top of upstream,
# so the remote ref has to match the local one even when the rebase was a
# no-op. Without this, a branch pushed from an older base — or one rebased in a
# run that did not push — stays stale on the remote, and a --no-rebase sync
# merges that stale ref back in.
publish_branch() {
  local branch="$1" local_sha remote_sha
  local_sha="$(git rev-parse "$branch")"
  remote_sha="$(git rev-parse -q --verify "$FORK_REMOTE/$branch" || true)"
  [ "$local_sha" != "$remote_sha" ] || return 0
  # The remote has commits this checkout does not. Force-pushing would drop
  # them, and --force-with-lease would not catch it because we just fetched.
  if [ -n "$remote_sha" ] && git merge-base --is-ancestor "$branch" "$FORK_REMOTE/$branch"; then
    warn "$FORK_REMOTE/$branch is ahead of local $branch — not pushing. Reset to it, or rebase it onto $BASE by hand"
    return 0
  fi
  if [ "$push" -eq 0 ]; then
    say "$branch differs from $FORK_REMOTE/$branch — push it with: git push --force-with-lease $FORK_REMOTE $branch"
    return 0
  fi
  git push --force-with-lease="$branch:$remote_sha" "$FORK_REMOTE" "$branch:$branch"
  say "pushed $branch to $FORK_REMOTE"
}

# A patch branch is a linear series of commits on top of upstream. Branching off
# the integration branch instead produces one that also carries the whole patch
# stack, and the giveaway is a merge commit: upstream's history is linear, and
# the integration branch is nothing but merges. Catching it here matters more
# now that the integration branch is called `main`, which is what everyone's
# fingers type after `git switch -c`.
assert_forked_from_upstream() {
  local branch="$1" merges
  merges="$(git rev-list --merges "$branch" "^$BASE" | head -3)"
  [ -n "$merges" ] || return 0
  die "$branch has merge commits above $BASE — it was branched off the integration
branch, not off upstream. Rebase the real work onto upstream:
  git rebase --onto $BASE <last-integration-commit> $branch
Start the next one with fork/new-branch.sh so this cannot happen again."
}

# A rebase is in progress when git's state directory exists; REBASE_HEAD can
# linger after one finishes.
rebase_in_progress() {
  local dir="$1"
  [ -d "$(git -C "$dir" rev-parse --git-path rebase-merge)" ] ||
    [ -d "$(git -C "$dir" rev-parse --git-path rebase-apply)" ]
}

# Hand a stopped merge or rebase to a Paseo agent. Returns non-zero if the
# agent did not finish the job.
resolve_with_agent() {
  local dir="$1" what="$2"
  command -v paseo >/dev/null 2>&1 || die "--agent needs the paseo CLI on PATH"
  local files
  files="$(git -C "$dir" diff --name-only --diff-filter=U | sed 's/^/  /')"
  say "Handing $what to a Paseo agent ($FORK_AGENT_PROVIDER)"
  paseo run \
    --cwd "$dir" \
    --provider "$FORK_AGENT_PROVIDER" \
    --mode auto \
    --wait-timeout "$FORK_AGENT_TIMEOUT" \
    --title "fork sync: resolve $what" \
    --label fork-sync=1 \
    "You are resolving a git merge conflict in a throwaway integration worktree at $dir.

Context: this checkout is the '$TARGET' integration branch being rebuilt as
'$UPSTREAM_REMOTE/$UPSTREAM_BRANCH' plus a series of personal patch branches. The
conflict is between new upstream code and one of those patches ($what).

Conflicted files:
$files

Do this and nothing else:
1. Read both sides of every conflict. 'ours' is upstream plus the patches merged
   so far; 'theirs' is the patch branch being merged.
2. Resolve so the upstream change and the intent of the patch both survive. When
   upstream has restructured or already implemented what the patch did, prefer
   upstream and keep only what the patch adds on top. Never drop an upstream
   change to make a patch apply.
3. Leave no conflict markers anywhere.
4. Run 'npm run typecheck' and 'npm run lint' if the conflicts touched source
   files, and fix what you broke.
5. 'git add -A' and 'git commit --no-edit'. Do not push, do not amend history,
   do not touch any other branch or worktree.

If a conflict genuinely cannot be resolved without a decision only the repo
owner can make, stop, leave the conflict in place, and explain why." || true

  if [ -n "$(git -C "$dir" diff --name-only --diff-filter=U)" ]; then
    return 1
  fi
  if git -C "$dir" rev-parse --verify -q MERGE_HEAD >/dev/null 2>&1; then
    git -C "$dir" commit --no-edit >/dev/null
  fi
  return 0
}

# ---------------------------------------------------------------- fetch ----

if [ "$fetch" -eq 1 ]; then
  say "Fetching $UPSTREAM_REMOTE and $FORK_REMOTE"
  git fetch --prune "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH"
  git fetch --prune "$FORK_REMOTE"
fi

BASE="$UPSTREAM_REMOTE/$UPSTREAM_BRANCH"
git rev-parse --verify -q "$BASE^{commit}" >/dev/null || die "cannot resolve $BASE"
git rev-parse --verify -q "$TOOLING_REF^{commit}" >/dev/null ||
  die "base branch '$TOOLING_REF' not found — it holds fork/branches and these scripts"

mapfile -t REFS < <(read_branch_list)
MERGE_REFS=("$TOOLING_REF" ${REFS[@]+"${REFS[@]}"})
for ref in "${MERGE_REFS[@]}"; do
  git rev-parse --verify -q "$ref^{commit}" >/dev/null ||
    die "cannot resolve '$ref' (listed in fork/branches on $TOOLING_REF)"
done

say "Base: $BASE ($(git log -1 --format='%h %s' "$BASE"))"

# --------------------------------------------------------------- rebase ----
# Optional: move the patch branches themselves onto current upstream, so their
# PRs stay mergeable and the integration merges stay trivial. Only local
# branches are rebased; a remote-tracking ref is rebased through its local
# branch of the same name when one exists.
#
# fork-base is rebased with the rest: it edits app.config.js, CLAUDE.md and
# scripts/ci-workflow.test.mjs, so it collides with upstream like any patch.

if [ "$do_rebase" -eq 1 ]; then
  for ref in "$TOOLING_REF" ${REFS[@]+"${REFS[@]}"}; do
    local_branch="${ref#"$FORK_REMOTE"/}"
    git show-ref --verify -q "refs/heads/$local_branch" || {
      warn "no local branch '$local_branch' to rebase — merging $ref as-is"
      continue
    }
    assert_forked_from_upstream "$local_branch"
    if git merge-base --is-ancestor "$BASE" "$local_branch"; then
      say "rebase $local_branch: already on $BASE"
      [ "$local_branch" = "$TOOLING_REF" ] || publish_branch "$local_branch"
      continue
    fi
    rb="$WORK_ROOT/rebase"
    rm -rf "$rb"
    git worktree prune
    git worktree add --detach "$rb" "$local_branch" >/dev/null
    # A rebase can stop once per commit, so keep resolving until it is done.
    git -C "$rb" rebase "$BASE" >/dev/null 2>&1 || true
    while rebase_in_progress "$rb"; do
      if [ "$use_agent" -eq 1 ] && resolve_with_agent "$rb" "rebase of $local_branch onto $BASE"; then
        GIT_EDITOR=true git -C "$rb" rebase --continue >/dev/null 2>&1 || true
        continue
      fi
      git -C "$rb" rebase --abort >/dev/null 2>&1 || true
      git worktree remove --force "$rb" >/dev/null 2>&1 || true
      die "rebase of $local_branch onto $BASE stopped on a conflict. Rebase it by hand, or re-run with --agent."
    done
    rebased_sha="$(git -C "$rb" rev-parse HEAD)"
    git worktree remove --force "$rb" >/dev/null 2>&1 || true
    move_branch "$local_branch" "$rebased_sha"
    say "rebased $local_branch onto $BASE"
    # bump_build_number commits to the base branch and pushes it right after
    # this loop, so publishing it here would push a half-finished state.
    [ "$local_branch" = "$TOOLING_REF" ] || publish_branch "$local_branch"
  done
  # Rebased local branches are now ahead of their remote refs; merge those.
  for i in "${!REFS[@]}"; do
    lb="${REFS[$i]#"$FORK_REMOTE"/}"
    git show-ref --verify -q "refs/heads/$lb" && REFS[$i]="$lb"
  done
  MERGE_REFS=("$TOOLING_REF" ${REFS[@]+"${REFS[@]}"})
fi

bump_build_number

# ---------------------------------------------------------------- build ----

if [ -e "$SYNC_DIR" ]; then
  if git -C "$SYNC_DIR" rev-parse --verify -q MERGE_HEAD >/dev/null 2>&1; then
    die "a previous sync stopped on a conflict in:
  $SYNC_DIR
Finish it (git -C '$SYNC_DIR' status), or throw it away:
  git worktree remove --force '$SYNC_DIR'"
  fi
  git worktree remove --force "$SYNC_DIR" >/dev/null 2>&1 || rm -rf "$SYNC_DIR"
fi
git worktree prune
mkdir -p "$WORK_ROOT"

git worktree add --detach "$SYNC_DIR" "$BASE" >/dev/null
cleanup() { git worktree remove --force "$SYNC_DIR" >/dev/null 2>&1 || true; }
trap cleanup EXIT

for ref in "${MERGE_REFS[@]}"; do
  short="$(git log -1 --format='%h' "$ref")"
  if git -C "$SYNC_DIR" merge --no-ff --no-edit \
    -m "Merge $ref into $TARGET" "$ref" >/dev/null 2>&1; then
    say "merged $ref ($short)"
    continue
  fi
  # rerere may have replayed a stored resolution already.
  if [ -z "$(git -C "$SYNC_DIR" diff --name-only --diff-filter=U)" ]; then
    git -C "$SYNC_DIR" commit --no-edit >/dev/null
    say "merged $ref ($short) — conflict replayed from rerere"
    continue
  fi
  if [ "$use_agent" -eq 1 ] && resolve_with_agent "$SYNC_DIR" "merge of $ref"; then
    say "merged $ref ($short) — conflict resolved by agent"
    continue
  fi
  trap - EXIT
  printf '\033[31mconflict\033[0m merging %s:\n' "$ref" >&2
  git -C "$SYNC_DIR" diff --name-only --diff-filter=U | sed 's/^/  /' >&2
  cat >&2 <<EOF

Resolve it in the sync worktree, then re-run this script:

  cd $SYNC_DIR
  # edit, then:
  git add -A && git commit --no-edit
  fork/sync.sh

Or re-run with --agent to let a Paseo agent try.
The resolution is recorded by rerere and replayed on future syncs.
To abandon: git worktree remove --force '$SYNC_DIR'
EOF
  exit 1
done

RESULT="$(git -C "$SYNC_DIR" rev-parse HEAD)"

move_branch "$TARGET" "$RESULT"

cleanup
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
