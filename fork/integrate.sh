#!/usr/bin/env bash
#
# fork/integrate.sh — maintain the integration branch.
#
#   fork-integration = upstream/main + fork-base + every ref in fork/branches
#   main             = fork-integration's tree, as one commit on top of upstream
#
# fork-integration is kept between runs. The routine update merges the latest
# upstream into it — one merge, so every conflict shows up once, in one place —
# and the patch branches are only rebased when you ask for it. main is derived
# from it on every run and always force-pushed.
#
# Commands:
#   fork/integrate.sh rebase            merge current upstream/main in, publish main
#   fork/integrate.sh add <branch>      list <branch> in fork/branches and merge it in
#   fork/integrate.sh rebuild           rebuild from upstream/main + fork-base + fork/branches
#   fork/integrate.sh rebase-branches   rebase fork-base and our patch branches onto
#                                       upstream/main, then rebuild
#
# Flags:
#   --push       push fork-base, fork-integration and main (and rebased branches)
#   --agent      hand conflicts to a Paseo agent
#   --no-fetch   use the refs already fetched
#
# See fork/README.md. Settings live in fork/config.sh.
# External PRs: add owner:branch to fetch from https://github.com/owner/paseo.git.
# These branches follow their authors, including force-pushes; we never rebase them.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=fork/config.sh
. "$HERE/config.sh"

cmd="" branch_arg=""
push=0 fetch=1 use_agent=0
for arg in "$@"; do
  case "$arg" in
    rebase | add | rebuild | rebase-branches)
      [ -z "$cmd" ] || die "one command at a time, not '$cmd' and '$arg'"
      cmd="$arg"
      ;;
    --push) push=1 ;;
    --agent) use_agent=1 ;;
    --no-fetch) fetch=0 ;;
    -h | --help)
      sed -n '3,25p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*) die "unknown flag: $arg" ;;
    *)
      [ "$cmd" = add ] && [ -z "$branch_arg" ] || die "unexpected argument: $arg"
      branch_arg="$arg"
      ;;
  esac
done
[ -n "$cmd" ] || die "pick one of: rebase, add <branch>, rebuild, rebase-branches (see --help)"
[ "$cmd" != add ] || [ -n "$branch_arg" ] || die "usage: fork/integrate.sh add <branch>"

require_repo

# Conflict resolutions are remembered and replayed, so a collision between
# upstream and a patch is hand-resolved once, not on every run.
[ "$(git config --get rerere.enabled || true)" = "true" ] || git config rerere.enabled true
[ "$(git config --get rerere.autoupdate || true)" = "true" ] || git config rerere.autoupdate true

TOOLING_DIR="$WORK_ROOT/tooling" # scratch worktree for commits to fork-base
REBASE_DIR="$WORK_ROOT/rebase"   # scratch worktree for rebasing one patch branch

# ------------------------------------------------------------- helpers ----

# The upstream version a commit carries.
version_at() {
  git show "$1:package.json" |
    node -pe 'JSON.parse(require("node:fs").readFileSync(0, "utf8")).version'
}

unmerged() { git -C "$1" diff --name-only --diff-filter=U; }

short() { git rev-parse --short "$1"; }

# Keep author-owned tips outside local branches and configured remotes. The
# portable owner:branch entry remains in fork/branches and build manifests.
EXTERNAL_PREFIX="refs/remotes/fork-pr/"
is_external_ref() { [[ "$1" == "$EXTERNAL_PREFIX"* ]]; }

branch_ref() {
  local entry="$1" owner branch
  if [[ "$entry" != *:* ]]; then
    echo "$entry"
    return 0
  fi
  owner="${entry%%:*}"
  branch="${entry#*:}"
  [[ "$owner" =~ ^[a-zA-Z0-9][a-zA-Z0-9-]*$ ]] &&
    git check-ref-format "refs/heads/$branch" ||
    die "invalid external branch '$entry' — expected owner:branch"
  echo "$EXTERNAL_PREFIX$owner/$branch"
}

branch_entry() {
  local ref="$1" path
  if is_external_ref "$ref"; then
    path="${ref#"$EXTERNAL_PREFIX"}"
    echo "${path%%/*}:${path#*/}"
  else
    echo "$ref"
  fi
}

fetch_external_ref() {
  local ref="$1" path owner branch
  is_external_ref "$ref" || return 0
  path="${ref#"$EXTERNAL_PREFIX"}"
  owner="${path%%/*}"
  branch="${path#*/}"
  if [ "$fetch" -eq 1 ]; then
    say "Fetching $owner:$branch from its author"
    git fetch --no-tags "https://github.com/$owner/paseo.git" "+refs/heads/$branch:$ref" ||
      die "could not fetch $owner:$branch — check the author's branch or remove its entry and rebuild; cached tips are used only with --no-fetch"
  fi
  git rev-parse --verify -q "$ref^{commit}" >/dev/null ||
    die "no fetched tip for $owner:$branch — run without --no-fetch"
}

# The worktree that has branch $1 checked out, if any.
worktree_of() {
  git worktree list --porcelain |
    awk -v b="refs/heads/$1" '/^worktree /{p=$2} /^branch /{if ($2==b) {print p; exit}}'
}

# `git branch -f` refuses to move a branch that is checked out somewhere, and
# patch branches, fork-base and main routinely are. Move the worktree instead.
move_branch() {
  local branch="$1" sha="$2" wt
  [ "$(git rev-parse -q --verify "refs/heads/$branch" || true)" != "$sha" ] || return 0
  wt="$(worktree_of "$branch")"
  if [ -z "$wt" ]; then
    git branch -f "$branch" "$sha"
    return
  fi
  [ -z "$(git -C "$wt" status --porcelain --untracked-files=no)" ] ||
    die "$branch is checked out with uncommitted changes in $wt — stash or discard them, then re-run"
  git -C "$wt" reset -q --hard "$sha"
  say "reset worktree $wt to the new $branch"
}

# Refuse before doing any work when a branch this command will move is checked
# out somewhere with local changes. Finding out at the end would leave the
# merges done and the branch not moved.
assert_movable() {
  local branch wt
  for branch in "$@"; do
    wt="$(worktree_of "$branch")"
    [ -n "$wt" ] || continue
    [ -z "$(git -C "$wt" status --porcelain --untracked-files=no)" ] ||
      die "$branch is checked out with uncommitted changes in $wt — stash or discard them, then re-run"
  done
}

# The listed refs that have a local branch of the same name — what
# rebase-branches rewrites.
local_patch_branches() {
  local ref name
  for ref in ${REFS[@]+"${REFS[@]}"}; do
    is_external_ref "$ref" && continue
    name="${ref#"$FORK_REMOTE"/}"
    git show-ref --verify -q "refs/heads/$name" && echo "$name"
  done
  return 0
}

# Catch a local branch up with its published copy when another checkout ran a
# command and pushed. Diverged is fatal: fork-integration's merge commits are
# the only record of the conflict resolutions in them, and --push would
# overwrite the remote's.
adopt_remote() {
  local branch="$1" remote="$FORK_REMOTE/$1"
  git rev-parse --verify -q "$remote^{commit}" >/dev/null || return 0
  git show-ref --verify -q "refs/heads/$branch" || return 0
  git merge-base --is-ancestor "$remote" "$branch" && return 0
  if git merge-base --is-ancestor "$branch" "$remote"; then
    move_branch "$branch" "$(git rev-parse "$remote")"
    say "$branch: fast-forwarded to $remote"
    return 0
  fi
  die "$branch and $remote have diverged. Pick one, then re-run:
  keep the remote:  git branch -f $branch $remote   (reset the checkout instead if it is checked out)
  keep the local:   git push --force-with-lease $FORK_REMOTE $branch"
}

# Every branch in fork/branches is meant to live directly on top of upstream,
# so the remote ref has to match the local one even when the rebase was a
# no-op. Without this, a branch pushed from an older base — or one rebased in a
# run that did not push — stays stale on the remote, and a later rebuild
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

# A patch branch is work on top of upstream and nothing else. One cut from
# main or fork-integration carries the whole patch stack, and the giveaway is
# fork-base's file list: no patch has a reason to ship fork/branches.
assert_patch_branch() {
  local ref="$1"
  [ "$ref" != "$TOOLING_REF" ] || return 0
  git cat-file -e "$ref:fork/branches" 2>/dev/null || return 0
  die "$ref carries fork/branches, so it was branched off $TARGET or $INTEGRATION_REF,
not off upstream, and would drag the whole patch stack in with it. Rebase the
real work onto upstream:
  git rebase --onto $BASE <last-integration-commit> $ref
Start the next one with fork/new-branch.sh so this cannot happen again."
}

# Only rebuild and rebase-branches need every listed ref to resolve; rebase
# and add warn about a dangling entry and leave it for the next rebuild.
validate_refs() {
  local ref
  for ref in ${REFS[@]+"${REFS[@]}"}; do
    git rev-parse --verify -q "$ref^{commit}" >/dev/null ||
      die "cannot resolve '$ref' (listed in fork/branches on $TOOLING_REF)"
  done
}

# Listed, in either spelling: origin/<name> or <name>.
is_listed() {
  local name="${1#"$FORK_REMOTE"/}" ref
  for ref in ${REFS[@]+"${REFS[@]}"}; do
    [ "${ref#"$FORK_REMOTE"/}" != "$name" ] || return 0
  done
  return 1
}

# The integration's own merges, newest first, as "<parents> <subject>". The
# walk stops at upstream: upstream's history has merge commits of its own,
# titled the same way ("Merge foo into main"), and they are not ours.
integration_merges() {
  local base
  git rev-parse --verify -q "$INTEGRATION_REF^{commit}" >/dev/null || return 0
  base="$(git merge-base "$BASE" "$INTEGRATION_REF" 2>/dev/null || true)"
  git log --first-parent --merges --format='%P %s' "$INTEGRATION_REF" ${base:+"^$base"}
}

# The tip of $1 as it was last merged into the integration, found through the
# merge commit's subject. Fails when it was never merged (or only by hand).
merged_tip_of() {
  local ref="$1" name="${1#"$FORK_REMOTE"/}" line tip
  local pattern=" Merge ($ref|$name|$FORK_REMOTE/$name) into ($INTEGRATION_REF|$TARGET)\$"
  [ "$ref" != "$TOOLING_REF" ] || pattern="$pattern| fork: build "
  line="$(integration_merges | grep -m1 -E "$pattern" || true)"
  [ -n "$line" ] || return 1
  tip="$(echo "$line" | cut -d' ' -f2)"
  # A rewritten branch is merged through a link commit; the real tip is its
  # first parent.
  case "$(git log -1 --format=%s "$tip")" in
    "fork: link "*) git rev-parse "$tip^1" ;;
    "fork: replay "*) git log -1 --format=%s "$tip" | cut -d' ' -f3 ;;
    *) echo "$tip" ;;
  esac
}

# An author can force-push back to a commit already in the integration's
# ancestry. Compare the last imported version, not just commit containment.
branch_is_integrated() {
  local ref="$1" tip="$2" merged
  if is_external_ref "$ref"; then
    merged="$(merged_tip_of "$ref" || true)"
    if [ -n "$merged" ]; then
      [ "$merged" = "$(git rev-parse "$ref")" ]
      return
    fi
  fi
  git merge-base --is-ancestor "$ref" "$tip"
}

# Every branch the integration's own merges brought in, newest first.
integrated_branches() {
  integration_merges | cut -d' ' -f3- |
    sed -n -E "s/^Merge ([^ ]+) into ($INTEGRATION_REF|$TARGET)\$/\1/p" |
    grep -vxF -- "$TOOLING_REF" | awk '!seen[$0]++' || true
}

# Whether every commit of $1 has an equivalent on upstream — the patch landed
# as a PR, so it is time to delete its line. Patch ids are computed the way
# `git cherry` does, but upstream's are computed once for all branches.
UPSTREAM_PATCH_IDS=""
upstream_patch_ids() {
  local ref base oldest=""
  for ref in ${REFS[@]+"${REFS[@]}"}; do
    base="$(git merge-base "$BASE" "$ref" 2>/dev/null || true)"
    [ -n "$base" ] || continue
    if [ -z "$oldest" ] || git merge-base --is-ancestor "$base" "$oldest"; then oldest="$base"; fi
  done
  [ -n "$oldest" ] || return 0
  git rev-list "$oldest..$BASE" | git diff-tree --stdin -p |
    git patch-id --stable | cut -d' ' -f1 | sort -u
}
# A branch merged upstream with a merge commit is simply contained in it; one
# squash-merged is not, and is found by its patch ids.
landed_upstream() {
  local ids id
  git merge-base --is-ancestor "$1" "$BASE" && return 0
  ids="$(git rev-list "$BASE..$1" | git diff-tree --stdin -p | git patch-id --stable | cut -d' ' -f1)"
  [ -n "$ids" ] || return 1
  for id in $ids; do
    grep -qxF -- "$id" <<<"$UPSTREAM_PATCH_IDS" || return 1
  done
  return 0
}

# ------------------------------------------------------------- tooling ----
# Commits to fork-base happen in a scratch worktree, so the checkout you run
# this from is untouched — unless it is fork-base itself, which is then reset
# to the result. Nothing is pushed until the whole command has succeeded.

commit_on_tooling() {
  local fn sha
  rm -rf "$TOOLING_DIR"
  git worktree prune
  git worktree add --detach "$TOOLING_DIR" "$TOOLING_REF" >/dev/null
  for fn in "$@"; do "$fn" "$TOOLING_DIR"; done
  sha="$(git -C "$TOOLING_DIR" rev-parse HEAD)"
  git worktree remove --force "$TOOLING_DIR" >/dev/null 2>&1 || true
  move_branch "$TOOLING_REF" "$sha"
}

tooling_commit() {
  git -C "$1" -c core.hooksPath=/dev/null commit -q -m "$2"
}

# fork/build-number holds the upstream version the counter belongs to and the
# counter itself ("0.7.2 13"). The counter restarts at 1 whenever the upstream
# version moves — see fork_version() in config.sh for why that is safe.
# BUMP_BASE is the version of the tree the number will identify.
BUMP_BASE="" BUILD_VERSION=""
bump_in() {
  local dir="$1" stored_base stored_number next
  read -r stored_base stored_number <<<"$(cat "$dir/fork/build-number" 2>/dev/null || true)"
  if [ "$stored_base" = "$BUMP_BASE" ] && [ -n "$stored_number" ]; then
    next=$((stored_number + 1))
  else
    next=1
    [ -z "$stored_base" ] || say "upstream is now $BUMP_BASE — restarting the fork counter"
  fi
  BUILD_VERSION="$BUMP_BASE-panrafal.$next"
  echo "$BUMP_BASE $next" >"$dir/fork/build-number"
  git -C "$dir" add fork/build-number
  tooling_commit "$dir" "fork: build $BUILD_VERSION"
}

# Append ADD_REF to fork/branches. New branches go last; order only matters at
# rebuild time, and a line can be moved by hand.
ADD_REF="" ADD_NAME=""
list_branch_in() {
  local dir="$1" file="$1/fork/branches"
  [ ! -s "$file" ] || [ -z "$(tail -c1 "$file")" ] || echo >>"$file"
  branch_entry "$ADD_REF" >>"$file"
  git -C "$dir" add fork/branches
  tooling_commit "$dir" "fork: add $ADD_NAME branch"
}

# ------------------------------------------------------------ conflicts ----

# Which listed branches touch each conflicted file, so a resolver can read a
# patch's intent from its own commits instead of guessing from the hunk.
attribution() {
  local dir="$1" ref base file touched
  local -A by_file=()
  for ref in "$TOOLING_REF" ${REFS[@]+"${REFS[@]}"}; do
    git rev-parse --verify -q "$ref^{commit}" >/dev/null || continue
    base="$(git merge-base "$BASE" "$ref" 2>/dev/null || true)"
    [ -n "$base" ] || continue
    touched="$(git diff --name-only "$base" "$ref")"
    while IFS= read -r file; do
      [ -n "$file" ] || continue
      grep -qxF -- "$file" <<<"$touched" || continue
      by_file[$file]="${by_file[$file]:-}${by_file[$file]:+, }$ref"
    done < <(unmerged "$dir")
  done
  while IFS= read -r file; do
    [ -n "$file" ] || continue
    printf '  %s: %s\n' "$file" "${by_file[$file]:-no listed branch touches this file}"
  done < <(unmerged "$dir")
}

# Hand a stopped merge or rebase to a Paseo agent. Returns non-zero if the
# agent did not finish the job.
resolve_with_agent() {
  local dir="$1" what="$2" sides="$3"
  command -v paseo >/dev/null 2>&1 || die "--agent needs the paseo CLI on PATH"
  say "Handing $what to a Paseo agent ($FORK_AGENT_PROVIDER)"
  paseo run \
    --cwd "$dir" \
    --provider "$FORK_AGENT_PROVIDER" \
    --mode auto \
    --wait-timeout "$FORK_AGENT_TIMEOUT" \
    --title "fork integrate: resolve $what" \
    --label fork-integrate=1 \
    "You are resolving a git conflict in a throwaway worktree at $dir.

Context: this fork keeps an integration branch, '$INTEGRATION_REF', that is
'$BASE' (upstream) plus a series of personal patch branches. The step that
stopped is the $what. $sides

Conflicted files, and the patch branches that touch each one. Read a patch's
intent from its own commits: git log $BASE..<branch> -- <file>
$(attribution "$dir")

Do this and nothing else:
1. Read both sides of every conflict.
2. Resolve so the upstream change and the intent of every patch both survive.
   When upstream has restructured or already implemented what a patch did,
   prefer upstream and keep only what the patch adds on top. Never drop an
   upstream change to make a patch apply, and never drop a patch's feature
   because its lines no longer fit — re-express it on the new code.
3. Leave no conflict markers anywhere.
4. Run 'npm run typecheck' and 'npm run lint' if the conflicts touched source
   files, and fix what you broke.
5. 'git add -A' and 'git commit --no-edit'. Do not push, do not amend history,
   do not touch any other branch or worktree.

If a conflict genuinely cannot be resolved without a decision only the repo
owner can make, stop, leave the conflict in place, and explain why." || true

  [ -z "$(unmerged "$dir")" ] || return 1
  if git -C "$dir" rev-parse --verify -q MERGE_HEAD >/dev/null 2>&1; then
    git -C "$dir" commit --no-edit >/dev/null
  fi
  return 0
}

sides_upstream() {
  echo "'ours' (HEAD) is $INTEGRATION_REF: the previous $BASE plus every fork patch, already merged and adapted to each other. 'theirs' is the new $BASE."
}
sides_branch() {
  local ref="$1" merged
  printf "'ours' (HEAD) is upstream plus the patches merged so far. 'theirs' is the patch branch %s." "$ref"
  merged="$(merged_tip_of "$ref" || true)"
  [ -n "$merged" ] || {
    echo
    return
  }
  if git merge-base --is-ancestor "$merged" "$ref"; then
    printf " It was merged before at %s and has gained commits since; only those are new." "$(short "$merged")"
  else
    printf " It was merged before at %s and has been rewritten since: where the branch's new version and the integration's copy of the old one disagree, the branch wins." "$(short "$merged")"
  fi
  echo
}
sides_tooling() {
  echo "'ours' (HEAD) is the integration. 'theirs' is $TOOLING_REF, the fork's own tooling: the fork/ directory, the build number, the fork's identity."
}
sides_rebase() {
  echo "'ours' (HEAD) is $BASE plus the patch commits already replayed. 'theirs' is the patch commit being replayed."
}

# --------------------------------------------------------------- merges ----
# The merges happen in a scratch worktree, so the checkout you run this from
# is untouched even mid-conflict. A stopped run leaves the worktree for you to
# resolve in; the re-run picks the finished merge up from there, so a fix made
# outside the conflict hunks is kept too.

marker_path() { git -C "$INTEGRATE_DIR" rev-parse --git-path fork-integrate-run; }

assert_no_stopped_run() {
  [ -e "$INTEGRATE_DIR" ] || return 0
  git -C "$INTEGRATE_DIR" rev-parse --verify -q MERGE_HEAD >/dev/null 2>&1 || return 0
  die "a previous run stopped on a conflict in:
  $INTEGRATE_DIR
Finish it (git -C '$INTEGRATE_DIR' status), or throw it away:
  git worktree remove --force '$INTEGRATE_DIR'"
}

# Start (or continue) the worktree for this command from commit $1. The
# marker names the command, its argument and the start commit, so a worktree
# left by `add x` is not picked up by `add y`.
open_worktree() {
  local start="$1" want="$cmd${2:+ $2} $1" have
  if [ -e "$INTEGRATE_DIR" ]; then
    assert_no_stopped_run
    have="$(cat "$(marker_path)" 2>/dev/null || true)"
    if [ "$have" = "$want" ] &&
      [ -z "$(git -C "$INTEGRATE_DIR" status --porcelain --untracked-files=no)" ] &&
      git merge-base --is-ancestor "$start" "$(worktree_head)"; then
      say "continuing from the merge finished in $INTEGRATE_DIR"
      trap close_worktree EXIT
      return 0
    fi
    [ -z "$have" ] ||
      say "discarding the worktree of an earlier '${have% *}' run — this one is '${want% *}' from $(short "$start")"
    git worktree remove --force "$INTEGRATE_DIR" >/dev/null 2>&1 || rm -rf "$INTEGRATE_DIR"
  fi
  git worktree prune
  mkdir -p "$WORK_ROOT"
  git worktree add --detach "$INTEGRATE_DIR" "$start" >/dev/null
  echo "$want" >"$(marker_path)"
  trap close_worktree EXIT
}

close_worktree() { git worktree remove --force "$INTEGRATE_DIR" >/dev/null 2>&1 || true; }

worktree_head() { git -C "$INTEGRATE_DIR" rev-parse HEAD; }

# Merge $ref into the worktree as a merge commit titled $subject. A conflict
# is resolved by rerere, then by the agent, and otherwise stops the run with
# the worktree left in place.
merge_ref() {
  local ref="$1" subject="$2" what="$3" sides="$4" shown="${5:-$1}" out
  if git merge-base --is-ancestor "$ref" "$(worktree_head)"; then
    say "$shown ($(short "$ref")) is already in"
    return 0
  fi
  if out="$(git -C "$INTEGRATE_DIR" merge --no-ff --no-edit -m "$subject" "$ref" 2>&1)"; then
    say "merged $shown ($(short "$ref"))"
    return 0
  fi
  git -C "$INTEGRATE_DIR" rev-parse --verify -q MERGE_HEAD >/dev/null 2>&1 ||
    die "merge of $ref failed:
$out"
  # rerere may have replayed a stored resolution already.
  if [ -z "$(unmerged "$INTEGRATE_DIR")" ]; then
    git -C "$INTEGRATE_DIR" commit --no-edit >/dev/null
    say "merged $shown ($(short "$ref")) — conflict replayed from rerere"
    return 0
  fi
  if [ "$use_agent" -eq 1 ] && resolve_with_agent "$INTEGRATE_DIR" "$what" "$sides"; then
    say "merged $shown ($(short "$ref")) — conflict resolved by agent"
    return 0
  fi
  stop_on_conflict "$shown"
}

# Merge a listed branch. One that was rewritten since it was last merged
# (amended, rebased) is merged through a link commit: the new tip with the old
# tip as a second parent. Merging the new tip directly would compare it with
# the integration over their common upstream base and conflict on every
# amended line; with the old tip as a merge base, only the delta between the
# two versions lands.
merge_branch() {
  local ref="$1" merged target="$1"
  if branch_is_integrated "$ref" "$(worktree_head)"; then
    say "$ref ($(short "$ref")) is already in"
    return 0
  fi
  assert_patch_branch "$ref"
  merged="$(merged_tip_of "$ref" || true)"
  if is_external_ref "$ref" && [ -n "$merged" ] && git merge-base --is-ancestor "$ref" "$(worktree_head)"; then
    # Both versions are already ancestors, so linking the author tip would
    # let Git choose that tip as the base and discard the requested change.
    target="$(git commit-tree "$ref^{tree}" -p "$merged" \
      -m "fork: replay $(git rev-parse "$ref") over $merged for $ref")"
  elif [ -n "$merged" ] && ! git merge-base --is-ancestor "$merged" "$ref"; then
    target="$(git commit-tree "$ref^{tree}" -p "$ref" -p "$merged" \
      -m "fork: link $ref to its previous tip $merged")"
  fi
  merge_ref "$target" "Merge $ref into $INTEGRATION_REF" \
    "merge of $ref into $INTEGRATION_REF" "$(sides_branch "$ref")" "$ref"
}

stop_on_conflict() {
  local ref="$1"
  trap - EXIT
  printf '\033[31mconflict\033[0m merging %s:\n' "$ref" >&2
  unmerged "$INTEGRATE_DIR" | sed 's/^/  /' >&2
  cat >&2 <<MSG

Resolve it in the worktree, then re-run this command; it continues from the
merge you committed there:

  cd $INTEGRATE_DIR
  # edit, then:
  git add -A && git commit --no-edit
  fork/integrate.sh $cmd${branch_arg:+ $branch_arg}

Or re-run with --agent to let a Paseo agent try.
To abandon: git worktree remove --force '$INTEGRATE_DIR'
MSG
  exit 1
}

# Give the result a build number: bump it on fork-base and merge that in, so
# the number is inside the commit it identifies. Runs after every content
# merge because fork/build-number has to count the version the tree carries,
# and an upstream or patch merge can move it. Extra arguments are further
# commits to make on fork-base first.
stamp() {
  BUMP_BASE="$(version_at "$(worktree_head)")"
  commit_on_tooling "$@" bump_in
  say "Build $BUILD_VERSION"
  merge_ref "$TOOLING_REF" "fork: build $BUILD_VERSION" \
    "merge of $TOOLING_REF into $INTEGRATION_REF" "$(sides_tooling)"
}

# -------------------------------------------------------------- publish ----

# main is the integration re-based onto upstream: the newest upstream commit
# the integration contains, plus one commit carrying the integration's whole
# tree. Its message says what went in. It is a rewrite every time, so it is
# always force-pushed; consumers reset to it, never pull.
publish_target() {
  local tip="$1" base tree sha
  base="$(git merge-base "$BASE" "$tip")"
  tree="$(git rev-parse "$tip^{tree}")"
  if git show-ref --verify -q "refs/heads/$TARGET" &&
    [ "$(git rev-parse "$TARGET^{tree}")" = "$tree" ] &&
    [ "$(git rev-parse -q --verify "$TARGET^1" || true)" = "$base" ]; then
    return 0
  fi
  sha="$(target_message "$tip" "$base" | git commit-tree "$tree" -p "$base")"
  move_branch "$TARGET" "$sha"
}

# Full ids, not short ones: ensure_integration reads them back to rebuild the
# integration's ancestry from a clone that only has main.
target_message() {
  local tip="$1" base="$2" ref entry merged
  echo "fork: build $(git show "$tip:fork/build-number" | awk '{print $1 "-panrafal." $2}')"
  echo
  echo "$BASE: $base $(git log -1 --format=%s "$base")"
  echo "$INTEGRATION_REF: $tip"
  echo "$TOOLING_REF: $(merged_tip_of "$TOOLING_REF" || git rev-parse "$TOOLING_REF")"
  echo "branches:"
  while read -r entry; do
    [ -n "$entry" ] || continue
    ref="$(branch_ref "$entry")"
    if merged="$(merged_tip_of "$ref")"; then
      :
    elif git rev-parse --verify -q "$ref^{commit}" >/dev/null && git merge-base --is-ancestor "$ref" "$tip"; then
      merged="$(git rev-parse "$ref")"
    else
      merged="not merged"
    fi
    echo "  $entry $merged"
  done < <(git show "$tip:fork/branches" | sed -e 's/#.*//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e '/^$/d')
}

# Commits made on main by hand, which the next publish drops. Build commits
# are what publish_target itself makes.
stray_main_commits() {
  git show-ref --verify -q "refs/heads/$TARGET" || {
    echo 0
    return
  }
  local r not=("^$BASE")
  for r in "$FORK_REMOTE/$TARGET" "$INTEGRATION_REF"; do
    git rev-parse --verify -q "$r^{commit}" >/dev/null && not+=("^$r")
  done
  git log --format=%s "$TARGET" "${not[@]}" | grep -vc '^fork: build ' || true
}

push_all() {
  if [ "$push" -eq 1 ]; then
    say "Pushing $TOOLING_REF, $INTEGRATION_REF and $TARGET to $FORK_REMOTE"
    git push --atomic --force-with-lease "$FORK_REMOTE" \
      "$TOOLING_REF:$TOOLING_REF" "$INTEGRATION_REF:$INTEGRATION_REF" "$TARGET:$TARGET"
  else
    echo
    echo "Not pushed. To publish:"
    echo "    git push --atomic --force-with-lease $FORK_REMOTE $TOOLING_REF $INTEGRATION_REF $TARGET"
    echo "  or re-run with --push."
  fi
}

# Move fork-integration to the worktree's result, derive main, publish.
finish() {
  local from="$1" tip counted carried stray
  tip="$(worktree_head)"
  close_worktree
  trap - EXIT

  counted="$(git show "$tip:fork/build-number" | cut -d' ' -f1)"
  carried="$(version_at "$tip")"
  [ "$counted" = "$carried" ] ||
    die "fork/build-number in the result counts $counted but package.json says $carried"

  move_branch "$INTEGRATION_REF" "$tip"
  stray="$(stray_main_commits)"
  [ "$stray" -eq 0 ] ||
    warn "$TARGET has $stray commit(s) made by hand — dropping them; $TARGET is always rebuilt from $INTEGRATION_REF"
  publish_target "$tip"

  if [ "$tip" = "$from" ]; then
    say "$INTEGRATION_REF is $(git log -1 --format='%h %s' "$tip") — nothing changed"
  else
    say "$INTEGRATION_REF is now $(git log -1 --format='%h %s' "$tip")"
    git log --oneline --first-parent "$from..$tip" | sed 's/^/    /'
  fi
  say "$TARGET is $(short "$TARGET") = $BASE at $(short "$TARGET^") + $(git log -1 --format=%s "$TARGET")"
  push_all
}

# fork-integration is kept between runs, so rebase and add need one to start
# from. The published copy wins; a checkout that has none yet gets it from
# main, which is the last integration that was published.
ensure_integration() {
  local seed
  if git show-ref --verify -q "refs/heads/$INTEGRATION_REF"; then
    adopt_remote "$INTEGRATION_REF"
    return 0
  fi
  for seed in "$FORK_REMOTE/$INTEGRATION_REF" "$FORK_REMOTE/$TARGET" "$TARGET"; do
    git rev-parse --verify -q "$seed^{commit}" >/dev/null || continue
    if [ "$seed" = "$FORK_REMOTE/$INTEGRATION_REF" ]; then
      git branch --no-track "$INTEGRATION_REF" "$seed"
    else
      git branch --no-track "$INTEGRATION_REF" "$(seed_from_target "$seed")"
    fi
    say "$INTEGRATION_REF started from $seed ($(git log -1 --format='%h %s' "$seed"))"
    return 0
  done
  die "no $INTEGRATION_REF yet — build it first: fork/integrate.sh rebuild"
}

# An integration to start from, given only main. A main made by the old
# rebuild-every-time script is the integration itself. A derived main is one
# commit whose message names the integration and every branch tip that went
# into it; when the integration is gone, a commit with main's tree and those
# tips as parents restores the ancestry the drift checks and the fork-base
# merge depend on.
seed_from_target() {
  local main="$1" sha integration parents=()
  if [ -n "$(git rev-list --merges -n1 "$main" "^$BASE")" ]; then
    echo "$main"
    return 0
  fi
  integration="$(git log -1 --format=%B "$main" | sed -n "s/^$INTEGRATION_REF: \([0-9a-f]\{40\}\)\$/\1/p")"
  if [ -n "$integration" ] && git rev-parse --verify -q "$integration^{commit}" >/dev/null; then
    echo "$integration"
    return 0
  fi
  while read -r sha; do
    git rev-parse --verify -q "$sha^{commit}" >/dev/null || continue
    git merge-base --is-ancestor "$sha" "$main" && continue
    parents+=(-p "$sha")
  done < <(git log -1 --format=%B "$main" | grep -oE '[0-9a-f]{40}' | awk '!seen[$0]++')
  git commit-tree "$main^{tree}" -p "$main" ${parents[@]+"${parents[@]}"} \
    -m "fork: $INTEGRATION_REF restored from $TARGET $(short "$main")"
}

# --------------------------------------------------------------- rebase ----
# Merge the current upstream into the integration, and any listed branch that
# moved since it was last merged. One merge per moved thing, whatever the
# number of patch branches.

DRIFTED=()
report_drift() {
  local tip="$1" ref merged name
  UPSTREAM_PATCH_IDS="$(upstream_patch_ids)"
  for ref in ${REFS[@]+"${REFS[@]}"}; do
    if ! git rev-parse --verify -q "$ref^{commit}" >/dev/null; then
      warn "cannot resolve $ref, which fork/branches lists — delete the line or push the branch before the next rebuild"
      continue
    fi
    if landed_upstream "$ref"; then
      warn "$ref looks merged upstream (every commit has an equivalent on $BASE) — delete its line from fork/branches and run: fork/integrate.sh rebuild"
    fi
    branch_is_integrated "$ref" "$tip" && continue
    merged="$(merged_tip_of "$ref" || true)"
    if [ -z "$merged" ]; then
      say "$ref is listed but not in $INTEGRATION_REF — merging it"
    elif git merge-base --is-ancestor "$merged" "$ref"; then
      say "$ref gained commits since $(short "$merged") — merging them"
    else
      warn "$ref was rewritten since $(short "$merged") was merged — merging the new tip over the old one. If that conflicts badly: fork/integrate.sh rebase-branches"
    fi
    DRIFTED+=("$ref")
  done
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    is_listed "$name" && continue
    warn "$name is in $INTEGRATION_REF but no longer in fork/branches — only a rebuild drops it: fork/integrate.sh rebuild"
  done < <(integrated_branches)
}

cmd_rebase() {
  assert_no_stopped_run
  assert_movable "$TOOLING_REF" "$INTEGRATION_REF" "$TARGET"
  ensure_integration
  local before ref
  before="$(git rev-parse "$INTEGRATION_REF")"
  report_drift "$before"
  open_worktree "$before"
  merge_ref "$BASE" "Merge $BASE ($(short "$BASE")) into $INTEGRATION_REF" \
    "merge of $BASE into $INTEGRATION_REF" "$(sides_upstream)"
  for ref in ${DRIFTED[@]+"${DRIFTED[@]}"}; do
    merge_branch "$ref"
  done
  if [ "$(worktree_head)" = "$before" ] && git merge-base --is-ancestor "$TOOLING_REF" "$before"; then
    say "$INTEGRATION_REF already has $BASE, $TOOLING_REF and every listed branch"
  else
    stamp
  fi
  finish "$before"
}

# ------------------------------------------------------------------ add ----
# List one more branch and merge it in. The branch's own base comes along: one
# cut from today's upstream brings those upstream commits with it. The list
# and the build number are committed only once the merge has succeeded, so a
# stopped run leaves fork-base untouched.

# The ref to record: origin/<name> when it is published, the local branch
# otherwise, or any other ref that resolves.
resolve_add_ref() {
  local arg="$1" name remote
  if [[ "$arg" == *:* ]]; then
    branch_ref "$arg"
    return 0
  fi
  name="${arg#"$FORK_REMOTE"/}"
  remote="$FORK_REMOTE/$name"
  if git rev-parse --verify -q "$remote^{commit}" >/dev/null; then
    if git show-ref --verify -q "refs/heads/$name" && ! git merge-base --is-ancestor "$name" "$remote"; then
      die "local $name has commits $remote does not — push it first: git push --force-with-lease $FORK_REMOTE $name"
    fi
    echo "$remote"
    return 0
  fi
  if git show-ref --verify -q "refs/heads/$name"; then
    warn "$remote does not exist — recording the local branch; other checkouts cannot rebuild until it is pushed: git push -u $FORK_REMOTE $name"
    echo "$name"
    return 0
  fi
  if git rev-parse --verify -q "$arg^{commit}" >/dev/null; then
    echo "$arg"
    return 0
  fi
  die "cannot resolve '$arg': neither $remote nor a local branch '$name' exists"
}

cmd_add() {
  assert_no_stopped_run
  assert_movable "$TOOLING_REF" "$INTEGRATION_REF" "$TARGET"
  ensure_integration
  ADD_REF="$(resolve_add_ref "$branch_arg")"
  ADD_NAME="$(branch_entry "${ADD_REF#"$FORK_REMOTE"/}")"
  assert_patch_branch "$ADD_REF"
  local before listed=0
  before="$(git rev-parse "$INTEGRATION_REF")"
  if is_listed "$ADD_REF"; then
    listed=1
    branch_is_integrated "$ADD_REF" "$before" &&
      die "$ADD_REF is already listed in fork/branches and merged into $INTEGRATION_REF"
    say "$ADD_REF is already listed in fork/branches — merging it"
  fi
  open_worktree "$before" "$ADD_REF"
  merge_branch "$ADD_REF"
  if [ "$listed" -eq 1 ]; then
    stamp
  else
    stamp list_branch_in
    say "listed $ADD_REF in fork/branches on $TOOLING_REF"
  fi
  finish "$before"
}

# -------------------------------------------------------------- rebuild ----
# Start over from upstream: fork-base first, then every listed ref in order.
# The old integration, and any line removed from fork/branches, is gone —
# and so is any adaptation that lived only in the old integration's merges.

# Files any listed branch changes relative to upstream.
patch_files() {
  local ref base
  for ref in "$TOOLING_REF" ${REFS[@]+"${REFS[@]}"}; do
    base="$(git merge-base "$BASE" "$ref" 2>/dev/null || true)"
    [ -n "$base" ] || continue
    git diff --name-only "$base" "$ref"
  done | sort -u
}

cmd_rebuild() {
  assert_no_stopped_run
  assert_movable "$TOOLING_REF" "$INTEGRATION_REF" "$TARGET"
  validate_refs
  local ref old base
  old="$(git rev-parse -q --verify "refs/heads/$INTEGRATION_REF" || true)"
  base="$(git rev-parse "$BASE")"
  open_worktree "$base"
  merge_ref "$TOOLING_REF" "Merge $TOOLING_REF into $INTEGRATION_REF" \
    "merge of $TOOLING_REF into $INTEGRATION_REF" "$(sides_tooling)"
  for ref in ${REFS[@]+"${REFS[@]}"}; do
    assert_patch_branch "$ref"
    merge_ref "$ref" "Merge $ref into $INTEGRATION_REF" \
      "merge of $ref into $INTEGRATION_REF" "$(sides_branch "$ref")"
  done
  stamp
  finish "$base"
  # What the rebuild changed where the patches live. Upstream's own edits to
  # those files are in here too; a resolution that only the old integration
  # had shows up as a difference nobody made on a branch.
  [ -n "$old" ] || return 0
  local files=()
  mapfile -t files < <(patch_files)
  [ "${#files[@]}" -gt 0 ] || return 0
  say "Compared with the previous $INTEGRATION_REF, in the files the patches touch:"
  git diff --stat=100 "$old" "$INTEGRATION_REF" -- "${files[@]}" | sed 's/^/    /'
}

# ------------------------------------------------------ rebase-branches ----
# Move the patch branches themselves onto current upstream, so their PRs stay
# mergeable and the rebuild that follows merges cleanly. Only local branches
# are rebased; a remote-tracking ref is rebased through its local branch of
# the same name when one exists.
#
# fork-base is rebased with the rest: it edits app.config.js, CLAUDE.md and
# scripts/ci-workflow.test.mjs, so it collides with upstream like any patch.

rebase_in_progress() {
  local dir="$1"
  [ -d "$(git -C "$dir" rev-parse --git-path rebase-merge)" ] ||
    [ -d "$(git -C "$dir" rev-parse --git-path rebase-apply)" ]
}

# Which step the rebase is on, to tell a stop that was resolved from one that
# was not.
rebase_position() {
  cat "$(git -C "$1" rev-parse --git-path rebase-merge/msgnum)" 2>/dev/null ||
    cat "$(git -C "$1" rev-parse --git-path rebase-apply/next)" 2>/dev/null ||
    echo "?"
}

abandon_rebase() {
  git -C "$REBASE_DIR" rebase --abort >/dev/null 2>&1 || true
  git worktree remove --force "$REBASE_DIR" >/dev/null 2>&1 || true
}

# A rebase can stop once per commit, so keep resolving until it is done.
rebase_branch() {
  local branch="$1" position stopped_at sha
  rm -rf "$REBASE_DIR"
  git worktree prune
  git worktree add --detach "$REBASE_DIR" "$branch" >/dev/null
  git -C "$REBASE_DIR" rebase "$BASE" >/dev/null 2>&1 || true
  while rebase_in_progress "$REBASE_DIR"; do
    position="$(rebase_position "$REBASE_DIR")"
    stopped_at="$(git -C "$REBASE_DIR" rev-parse HEAD)"
    if [ -n "$(unmerged "$REBASE_DIR")" ]; then
      if [ "$use_agent" -eq 0 ] ||
        ! resolve_with_agent "$REBASE_DIR" "rebase of $branch onto $BASE" "$(sides_rebase)"; then
        abandon_rebase
        die "rebase of $branch onto $BASE stopped on a conflict. Rebase it by hand, or re-run with --agent."
      fi
    fi
    # Resolved, by rerere or by the agent. A resolution that leaves nothing to
    # commit means upstream already has this change: the commit is dropped.
    if [ "$(git -C "$REBASE_DIR" rev-parse HEAD)" = "$stopped_at" ] &&
      git -C "$REBASE_DIR" diff --quiet HEAD --; then
      GIT_EDITOR=true git -C "$REBASE_DIR" rebase --skip >/dev/null 2>&1 || true
    else
      GIT_EDITOR=true git -C "$REBASE_DIR" rebase --continue >/dev/null 2>&1 || true
    fi
    if rebase_in_progress "$REBASE_DIR" && [ "$(rebase_position "$REBASE_DIR")" = "$position" ]; then
      abandon_rebase
      die "rebase of $branch onto $BASE is not making progress. Rebase it by hand."
    fi
  done
  sha="$(git -C "$REBASE_DIR" rev-parse HEAD)"
  git worktree remove --force "$REBASE_DIR" >/dev/null 2>&1 || true
  move_branch "$branch" "$sha"
  say "rebased $branch onto $BASE"
}

# A local patch branch that is strictly behind its published copy — pushed
# to from another checkout — is caught up before it is rebased; rebasing the
# stale copy would rewrite it and the push would drop the newer commits.
# Diverged means a local rewrite not pushed yet: that one wins, as it always
# has for patch branches, but not silently.
catch_up_branch() {
  local branch="$1" remote="$FORK_REMOTE/$1"
  git rev-parse --verify -q "$remote^{commit}" >/dev/null || return 0
  git merge-base --is-ancestor "$remote" "$branch" && return 0
  if git merge-base --is-ancestor "$branch" "$remote"; then
    move_branch "$branch" "$(git rev-parse "$remote")"
    say "$branch: fast-forwarded to $remote"
    return 0
  fi
  warn "$branch and $remote have diverged — rebasing the local one; the push will drop what only $remote has"
}

rebase_patch_branches() {
  local ref local_branch i
  for ref in "$TOOLING_REF" ${REFS[@]+"${REFS[@]}"}; do
    if is_external_ref "$ref"; then
      say "$(branch_entry "$ref"): author-owned — merging fetched tip without rebasing or pushing"
      continue
    fi
    local_branch="${ref#"$FORK_REMOTE"/}"
    git show-ref --verify -q "refs/heads/$local_branch" || {
      warn "no local branch '$local_branch' to rebase — merging $ref as-is"
      continue
    }
    [ "$local_branch" = "$TOOLING_REF" ] || catch_up_branch "$local_branch"
    assert_patch_branch "$local_branch"
    if git merge-base --is-ancestor "$BASE" "$local_branch"; then
      say "rebase $local_branch: already on $BASE"
    else
      rebase_branch "$local_branch"
    fi
    publish_branch "$local_branch"
  done
  # Rebased local branches are now ahead of their remote refs; merge those.
  [ "${#REFS[@]}" -eq 0 ] || for i in "${!REFS[@]}"; do
    is_external_ref "${REFS[$i]}" && continue
    local_branch="${REFS[$i]#"$FORK_REMOTE"/}"
    if git show-ref --verify -q "refs/heads/$local_branch"; then
      REFS[$i]="$local_branch"
    fi
  done
  return 0
}

cmd_rebase_branches() {
  assert_no_stopped_run
  local locals=()
  mapfile -t locals < <(local_patch_branches)
  assert_movable "$TOOLING_REF" "$INTEGRATION_REF" "$TARGET" ${locals[@]+"${locals[@]}"}
  validate_refs
  rebase_patch_branches
  cmd_rebuild
}

# ----------------------------------------------------------------- main ----

if [ "$fetch" -eq 1 ]; then
  say "Fetching $UPSTREAM_REMOTE and $FORK_REMOTE"
  git fetch --prune "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH"
  git fetch --prune "$FORK_REMOTE"
fi

BASE="$UPSTREAM_REMOTE/$UPSTREAM_BRANCH"
git rev-parse --verify -q "$BASE^{commit}" >/dev/null || die "cannot resolve $BASE"
git rev-parse --verify -q "$TOOLING_REF^{commit}" >/dev/null ||
  die "base branch '$TOOLING_REF' not found — it holds fork/branches and these scripts"
adopt_remote "$TOOLING_REF"
mapfile -t REFS < <(read_branch_list)
for i in "${!REFS[@]}"; do
  REFS[$i]="$(branch_ref "${REFS[$i]}")"
done
dup="$(printf '%s\n' ${REFS[@]+"${REFS[@]}"} | sort | uniq -d)"
[ -z "$dup" ] || die "fork/branches lists these more than once:
$dup"
for ref in ${REFS[@]+"${REFS[@]}"}; do
  fetch_external_ref "$ref"
done
if [ "$cmd" = add ]; then
  add_ref="$(branch_ref "$branch_arg")"
  is_listed "$add_ref" || fetch_external_ref "$add_ref"
fi
say "Base: $BASE ($(git log -1 --format='%h %s' "$BASE"))"

case "$cmd" in
  rebase) cmd_rebase ;;
  add) cmd_add ;;
  rebuild) cmd_rebuild ;;
  rebase-branches) cmd_rebase_branches ;;
esac
