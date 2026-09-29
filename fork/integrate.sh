#!/usr/bin/env bash
#
# fork/integrate.sh — maintain the integration branch.
#
#   fork-upstream    = upstream/main, the base for new patch branches
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
#                                       upstream/main, verify each one, then rebuild;
#                                       FORK_JOBS branches at a time
#
# Flags:
#   --push       publish results, including fork-upstream on update/rebase
#   --agent      hand conflicts and build or test failures to a Paseo agent
#                (Codex Luna, xhigh thinking, by default)
#   --no-fetch   use the refs already fetched
#   --no-verify  skip the build, lint and tests (fork/verify.sh) of each rebased
#                branch and of the merged integration
#
# See fork/README.md. Settings live in fork/config.sh.
# External PRs: add owner:branch to fetch from https://github.com/owner/paseo.git.
# These branches follow their authors, including force-pushes; we never rebase them.

# Load the script before running it. rebase-branches can move the branch this
# file is executing from; Bash otherwise reads the changed tail from disk.
if [ -n "${BASH_SOURCE[0]:-}" ]; then
  source_path="${BASH_SOURCE[0]}"
  exec bash -c "$(<"$source_path")" "$source_path" "$@"
fi

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=fork/config.sh
. "$HERE/config.sh"

cmd="" branch_arg=""
push=0 fetch=1 use_agent=0 verify=1
for arg in "$@"; do
  case "$arg" in
    rebase | add | rebuild | rebase-branches)
      [ -z "$cmd" ] || die "one command at a time, not '$cmd' and '$arg'"
      cmd="$arg"
      ;;
    --push) push=1 ;;
    --agent) use_agent=1 ;;
    --no-fetch) fetch=0 ;;
    --no-verify) verify=0 ;;
    -h | --help)
      sed -n '3,30p' "$0" | sed 's/^# \{0,1\}//'
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
refresh_upstream=0
case "$cmd" in
  rebase | rebase-branches) refresh_upstream=1 ;;
esac

require_repo

# Conflict resolutions are remembered and replayed, so a collision between
# upstream and a patch is hand-resolved once, not on every run.
[ "$(git config --get rerere.enabled || true)" = "true" ] || git config rerere.enabled true
[ "$(git config --get rerere.autoupdate || true)" = "true" ] || git config rerere.autoupdate true

TOOLING_DIR="$WORK_ROOT/tooling" # scratch worktree for commits to fork-base
VERIFY_CMD="${FORK_VERIFY_CMD:-$HERE/verify.sh}"
VERIFY_LOG="$WORK_ROOT/verify.log"
VERIFY_DIR="$WORK_ROOT/verify"         # checkout every verify runs in (keeps node_modules)
VERIFIED_LIST="$WORK_ROOT/verified"    # commits that passed, one sha per line
JOB_DIR="$WORK_ROOT/rebase-branches"   # rebase-branches' per-branch logs and verify locks
SAVED_DIR="$WORK_ROOT/saved"           # checkouts of rebases an agent did not finish
JOB=0                                  # 1 inside a rebase-branches job
JOB_BRANCH=""                          # the branch that job works on
JOB_AGENT=""                           # the agent that job already started
AGENT_LIST="$WORK_ROOT/agents"         # agents this run started, to stop on Ctrl-C

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

# fork/build-number holds the X.Y.Z core the counter belongs to and the
# counter itself ("0.7.2 13"). The counter restarts at 1 whenever that core
# moves — see fork_version() in config.sh for why that is safe. BUMP_BASE is
# the core of the tree the number will identify.
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

# Give the prompt in $3 to a Paseo agent working in $1, titled after $2, and
# wait for it to finish its turn. Inside a rebase-branches job the agent that
# resolved the branch's conflicts gets the next prompt too, so a build failure
# goes to the agent that already knows the branch. Returns non-zero unless the
# agent finished.
#
# The agent is started in the background and waited for separately, so its id
# is known while it works: a stopped run stops it (stop_agents) instead of
# leaving it editing a checkout the next run resets.
ask_agent() {
  local dir="$1" title="$2" prompt="$3" id out status=0
  command -v paseo >/dev/null 2>&1 || die "--agent needs the paseo CLI on PATH"
  check_stopped
  if [ -n "$JOB_AGENT" ]; then
    id="$JOB_AGENT"
    paseo send --no-wait "$id" "$prompt" >/dev/null || return 1
  else
    # A Paseo terminal exports PASEO_WORKSPACE_ID, and paseo run then starts
    # the agent in that workspace's directory whatever --cwd says.
    id="$(env -u PASEO_WORKSPACE_ID paseo run \
      --background --quiet \
      --cwd "$dir" \
      --provider "$FORK_AGENT_PROVIDER" \
      --model "$FORK_AGENT_MODEL" \
      --thinking "$FORK_AGENT_THINKING" \
      --mode "$FORK_AGENT_MODE" \
      --title "fork integrate: $title" \
      --label fork-integrate=1 \
      "$prompt")" || return 1
    [ -n "$id" ] || return 1
  fi
  echo "$id" >>"$AGENT_LIST"
  progress "${JOB_BRANCH:+$JOB_BRANCH: }agent $id ($FORK_AGENT_MODEL, $FORK_AGENT_THINKING) is on it — watch: paseo logs -f $id"
  [ "$JOB" -eq 1 ] || trap 'stop_agents; exit 130' INT TERM
  out="$(paseo wait --timeout "$FORK_AGENT_TIMEOUT" --format json "$id")" || status=$?
  [ "$JOB" -eq 1 ] || trap - INT TERM
  [ -z "$out" ] || printf '%s\n' "$out"
  [ "$JOB" -eq 0 ] || JOB_AGENT="$id"
  [ "$status" -eq 0 ] && [ "$(json_field status <<<"$out")" = idle ] && return 0
  # Timed out or stuck on a permission: it must not keep editing the checkout.
  paseo stop "$id" >/dev/null 2>&1 || true
  return 1
}

# Interrupt every agent this run started. One that already finished ignores it.
stop_agents() {
  local id
  [ -f "$AGENT_LIST" ] || return 0
  sort -u "$AGENT_LIST" | while IFS= read -r id; do
    [ -n "$id" ] || continue
    paseo stop "$id" >/dev/null 2>&1 && say "stopped agent $id" || true
  done
  rm -f "$AGENT_LIST"
}

# After Ctrl-C a job can still see a build fail because the interrupt killed
# it; it must not start an agent or push on that.
check_stopped() {
  [ ! -e "$JOB_DIR/stopped" ] || [ "$JOB" -eq 0 ] || die "stopped"
}

json_field() {
  node -e 'let d = {}
try { d = JSON.parse(require("node:fs").readFileSync(0, "utf8")) } catch {}
process.stdout.write(String(d[process.argv[1]] ?? ""))' "$1"
}

# Hand a stopped merge or rebase to a Paseo agent. Returns non-zero if the
# agent did not finish the job.
resolve_with_agent() {
  local dir="$1" what="$2" sides="$3" operation="${4:-merge}" agent_status=0 steps
  if [ "$operation" = rebase ]; then
    steps="4. Own the remaining rebase through completion. For each stopped commit,
   read 'git rebase --show-current-patch', resolve and 'git add -A', then run
   'GIT_EDITOR=true git -c core.hooksPath=/dev/null rebase --continue'. Repeat
   for every later conflict.
   Use 'git rebase --skip' only when the entire commit is already implemented
   upstream. Do not abort or restart the rebase, or change its todo list.
5. Leave a clean worktree with no rebase in progress. Do not build, typecheck
   or test: the result is verified next, and a failure comes back to you.
6. Do not push or update any branch ref, and do not touch another worktree."
  else
    steps="4. Do not build, typecheck or test: this worktree has no dependencies
   installed, and the integration is verified after the last merge.
5. 'git add -A' and 'git -c core.hooksPath=/dev/null commit --no-edit'. Do not
   push, do not amend history, do not touch any other branch or worktree."
  fi
  section "🤖" "Resolve $what"
  ask_agent "$dir" "resolve $what" "You are resolving a git conflict in a throwaway worktree at $dir.

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
$steps

If a conflict genuinely cannot be resolved without a decision only the repo
owner can make, stop, leave the worktree in place, and explain why." || agent_status=$?

  if [ "$operation" = rebase ]; then
    [ "$agent_status" -eq 0 ] || return 1
    ! rebase_in_progress "$dir" || return 1
    git -C "$dir" merge-base --is-ancestor "$BASE" HEAD || return 1
    [ -z "$(git -C "$dir" status --porcelain)" ] || return 1
  fi

  [ -z "$(unmerged "$dir")" ] || return 1
  if git -C "$dir" rev-parse --verify -q MERGE_HEAD >/dev/null 2>&1; then
    git -C "$dir" -c core.hooksPath=/dev/null commit --no-edit >/dev/null
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

# ----------------------------------------------------------- verify ----
# Build and test the merged tree before it is stamped. A clean merge can still
# break the build: upstream renames or changes a signature a patch calls, and
# git has nothing to say about it. With --agent a failure is handed to an
# agent, which commits its fix into the integration; otherwise, or when the
# fix does not pass either, the run stops with the worktree left in place,
# like a conflict.
#
# Every verify, of a branch or of the integration, runs in one checkout that
# keeps its node_modules and build outputs, so an unchanged lockfile costs no
# install and an unchanged library no build (fork/verify.sh). A commit
# that passes is recorded, and a later verify of a tree derived from it only
# checks what changed since (fork/verify.sh).

open_verify_dir() {
  local sha="$1"
  # COMPAT(verify-dir): the checkout was verify-branch before 2026-09-29; moving
  # it keeps its node_modules. Remove after 2026-12-31.
  [ -e "$VERIFY_DIR" ] || [ ! -d "$WORK_ROOT/verify-branch" ] ||
    git worktree move "$WORK_ROOT/verify-branch" "$VERIFY_DIR" 2>/dev/null || true
  if ! git -C "$VERIFY_DIR" rev-parse --git-dir >/dev/null 2>&1; then
    rm -rf "$VERIFY_DIR"
    git worktree prune
    mkdir -p "$WORK_ROOT"
    git worktree add --detach "$VERIFY_DIR" "$sha" >/dev/null
    return 0
  fi
  # A run killed mid-rebase leaves one behind.
  ! rebase_in_progress "$VERIFY_DIR" || git -C "$VERIFY_DIR" rebase --abort >/dev/null 2>&1 || true
  git -C "$VERIFY_DIR" checkout -q -f --detach "$sha"
  git -C "$VERIFY_DIR" clean -q -fdx -e node_modules -e dist -e build
}

is_verified() { grep -qxF -- "$1" "$VERIFIED_LIST" 2>/dev/null; }
record_verified() {
  mkdir -p "$WORK_ROOT"
  git -C "$VERIFY_DIR" rev-parse HEAD >>"$VERIFIED_LIST"
}

# The commit to check changes since: $1 or its first parent, whichever passed
# before. The parent covers an integration tip, whose last commit is the build
# stamp merged in after the verify.
verified_since() {
  local ref="${1:-}" sha
  [ -n "$ref" ] || return 0
  for sha in "$(git rev-parse -q --verify "$ref^{commit}" || true)" \
    "$(git rev-parse -q --verify "$ref^1" 2>/dev/null || true)"; do
    [ -n "$sha" ] && is_verified "$sha" && {
      echo "$sha"
      return 0
    }
  done
  return 0
}

# $1 is the integration this run started from, if any.
verify_integration() {
  local since head
  if [ "$verify" -eq 0 ]; then
    say "Skipping build and tests (--no-verify)"
    return 0
  fi
  section "🧪" "Verify integration"
  since="$(verified_since "${1:-}")"
  head="$(worktree_head)"
  open_verify_dir "$head"
  if run_verify "$VERIFY_DIR" "$since"; then
    record_verified
    return 0
  fi
  if [ "$use_agent" -eq 1 ] &&
    fix_with_agent "$VERIFY_DIR" "the integration build" "$(integration_fix_context)" \
      "6. In your final message, name the patch branch that should carry the fix,
   so the owner can move it there." &&
    run_verify "$VERIFY_DIR" "$since"; then
    git -C "$INTEGRATE_DIR" checkout -q --detach "$(git -C "$VERIFY_DIR" rev-parse HEAD)"
    record_verified
    warn "the fix lives only in $INTEGRATION_REF — move it to the patch branch it belongs to, or the next rebuild needs it again"
    return 0
  fi
  stop_on_verify_failure "$head"
}

run_verify() {
  local dir="$1" since="${2:-}" head
  head="$(git -C "$dir" rev-parse HEAD)"
  [ "$JOB" -eq 0 ] || take_verify_lock
  say "Building, linting and testing $(short "$head")${since:+, changes since $(short "$since")} — log in $VERIFY_LOG"
  mkdir -p "$WORK_ROOT"
  if "$VERIFY_CMD" "$dir" "$BASE" ${since:+"$since"} >"$VERIFY_LOG" 2>&1; then
    release_verify_lock
    say "build, lint and tests pass"
    return 0
  fi
  release_verify_lock
  warn "build, lint or tests failed at $(short "$head"):"
  tail -n 30 "$VERIFY_LOG" | sed 's/^/    /' >&2
  return 1
}

integration_fix_context() {
  cat <<CONTEXT
Context: this fork keeps an integration branch, '$INTEGRATION_REF', that is
'$BASE' (upstream) plus a series of personal patch branches, merged in. The
merges went through without conflicts, but the result does not build, lint or
pass its tests. The usual cause is an upstream change a patch did not expect: a
renamed export, a new required argument, a moved file.

Patch branches and the files each changes. Read a patch's intent from its own
commits: git log $BASE..<branch> -- <file>
$(branch_files)
CONTEXT
}

# Hand the failure in $VERIFY_LOG, verified in $1, to an agent that commits a
# fix on top of $1's HEAD. $2 names the job, $3 says what the tree is, $4 is an
# extra last step. Returns non-zero if the agent did not commit a fix.
fix_with_agent() {
  local dir="$1" what="$2" context="$3" last_step="${4:-}" before agent_status=0
  before="$(git -C "$dir" rev-parse HEAD)"
  section "🤖" "Fix $what"
  ask_agent "$dir" "fix $what" "You are fixing a failed build, lint or test run in a throwaway worktree at $dir.

$context

The full output is in $VERIFY_LOG; it was produced by fork/verify.sh, and
each step's heading there is the command it ran, from $dir.
Dependencies are already installed.

Do this and nothing else:
1. Find the cause of each failure. Read the upstream change with
   git log -p $BASE -- <file> and the patch's side with the command above.
2. Fix it so the upstream change and the intent of every patch both survive.
   Re-express the patch on upstream's new code. Never revert an upstream
   change, and never delete, skip or loosen a test or a lint rule to make it pass.
3. Re-run the step that failed, with the command in its heading, until it
   passes.
4. Discard build churn (git checkout -- package-lock.json and generated
   files you did not mean to change), then commit only your fix:
   git add <files> && git -c core.hooksPath=/dev/null commit -m 'Fix <what> after <upstream change>'
   Hooks are off because you already ran the checks they run.
5. Do not push, do not amend or rewrite history, do not touch any other
   branch or worktree.
$last_step

If the failure cannot be fixed without a decision only the repo owner can
make, stop without committing and explain why." || agent_status=$?

  [ "$agent_status" -eq 0 ] || return 1
  ! git -C "$dir" rev-parse --verify -q MERGE_HEAD >/dev/null 2>&1 || return 1
  [ "$(git -C "$dir" rev-parse HEAD)" != "$before" ] || return 1
  git merge-base --is-ancestor "$before" "$(git -C "$dir" rev-parse HEAD)" || return 1
  say "agent committed:"
  git -C "$dir" log --oneline "$before..HEAD" | sed 's/^/    /'
}

# Every listed branch and the files it changes relative to upstream.
branch_files() {
  local ref base
  for ref in ${REFS[@]+"${REFS[@]}"}; do
    base="$(git merge-base "$BASE" "$ref" 2>/dev/null || true)"
    [ -n "$base" ] || continue
    echo "  $ref:"
    git diff --name-only "$base" "$ref" | sed 's/^/    /'
  done
}

stop_on_verify_failure() {
  local head="$1" attempt
  trap - EXIT
  git -C "$INTEGRATE_DIR" checkout -q -- . 2>/dev/null || true
  git -C "$VERIFY_DIR" checkout -q -- . 2>/dev/null || true
  attempt="$(git -C "$VERIFY_DIR" rev-parse HEAD)"
  [ "$attempt" = "$head" ] || say "the agent's unfinished attempt is at $(short "$attempt"): git log $(short "$head")..$attempt"
  cat >&2 <<MSG

The merged integration does not build or pass its tests; nothing was stamped
or published. The output is in:

  $VERIFY_LOG

Fix it in the worktree, commit, then re-run this command; it continues from
your commit and verifies again:

  cd $INTEGRATE_DIR
  # edit, then:
  git add -A && git commit -m 'fork: fix ...'
  fork/integrate.sh $cmd${branch_arg:+ $branch_arg}

Better still, fix the patch branch that broke, push it, and re-run.
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
  BUMP_BASE="$(fork_version_core "$(version_at "$(worktree_head)")")"
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
  # Upstream's subject can carry [skip ci] and the like; GitHub honors those
  # anywhere in the head commit's message and would skip main's workflows.
  echo "$BASE: $base $(git log -1 --format=%s "$base" | tr '[]' '()')"
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
  local refs=("$TOOLING_REF:$TOOLING_REF" "$INTEGRATION_REF:$INTEGRATION_REF" "$TARGET:$TARGET")
  if [ "$refresh_upstream" -eq 1 ]; then
    refs=("$UPSTREAM_REF:$UPSTREAM_REF" "${refs[@]}")
  fi
  if [ "$push" -eq 1 ]; then
    say "Pushing ${refs[*]} to $FORK_REMOTE"
    git push --atomic --force-with-lease "$FORK_REMOTE" "${refs[@]}"
  else
    echo
    echo "Not pushed. To publish:"
    echo "    git push --atomic --force-with-lease $FORK_REMOTE ${refs[*]}"
    echo "  or re-run with --push."
  fi
}

# Move fork-integration to the worktree's result, derive main, publish.
finish() {
  local from="$1" tip counted carried stray
  tip="$(worktree_head)"
  close_worktree
  trap - EXIT

  section "📤" "Publish integration"

  counted="$(git show "$tip:fork/build-number" | cut -d' ' -f1)"
  carried="$(fork_version_core "$(version_at "$tip")")"
  [ "$counted" = "$carried" ] ||
    die "fork/build-number in the result counts $counted but package.json's core is $carried"

  if [ "$refresh_upstream" -eq 1 ]; then
    move_branch "$UPSTREAM_REF" "$(git rev-parse "$BASE")"
  fi
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
  section "🔀" "Rebase integration"
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
    verify_integration "$before"
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
  section "➕" "Add $branch_arg"
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
  verify_integration "$before"
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
  section "♻️" "Rebuild integration"
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
  verify_integration "$old"
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
  git -C "$VERIFY_DIR" rebase --abort >/dev/null 2>&1 || true
}

# Where the checkout of a rebase an agent did not finish is kept.
saved_dir_of() { echo "$SAVED_DIR/${1//\//__}"; }

# Move the job's checkout aside, rebase and node_modules included, so the next
# job in its slot does not reset it. That slot starts a fresh checkout.
save_checkout() {
  local branch="$1" saved
  saved="$(saved_dir_of "$branch")"
  mkdir -p "$SAVED_DIR"
  git worktree move "$VERIFY_DIR" "$saved"
  echo "$saved"
}

# Rebase in the job's checkout, which keeps its node_modules, so an agent that
# resolves a conflict there can build and test. A rebase can stop once per
# commit, so keep resolving until it is done.
rebase_branch() {
  local branch="$1" position stopped_at sha saved
  saved="$(saved_dir_of "$branch")"
  [ ! -e "$saved" ] || die "saved rebase worktree at $saved — recover it or explicitly remove it before retrying:
  git worktree remove --force '$saved'"
  open_verify_dir "$branch"
  git -C "$VERIFY_DIR" rebase "$BASE" >/dev/null 2>&1 || true
  while rebase_in_progress "$VERIFY_DIR"; do
    position="$(rebase_position "$VERIFY_DIR")"
    stopped_at="$(git -C "$VERIFY_DIR" rev-parse HEAD)"
    if [ -n "$(unmerged "$VERIFY_DIR")" ]; then
      if [ "$use_agent" -eq 0 ]; then
        abandon_rebase
        die "rebase of $branch onto $BASE stopped on a conflict. Rebase it by hand, or re-run with --agent."
      fi
      progress "$branch: rebase conflict"
      if ! resolve_with_agent "$VERIFY_DIR" "rebase of $branch onto $BASE" "$(sides_rebase)" rebase; then
        saved="$(save_checkout "$branch")"
        die "agent did not finish rebase of $branch onto $BASE. Worktree preserved at $saved; recover it before retrying."
      fi
      break
    fi
    # Resolved by rerere. A resolution that leaves nothing to
    # commit means upstream already has this change: the commit is dropped.
    if [ "$(git -C "$VERIFY_DIR" rev-parse HEAD)" = "$stopped_at" ] &&
      git -C "$VERIFY_DIR" diff --quiet HEAD --; then
      GIT_EDITOR=true git -C "$VERIFY_DIR" rebase --skip >/dev/null 2>&1 || true
    else
      GIT_EDITOR=true git -C "$VERIFY_DIR" -c core.hooksPath=/dev/null rebase --continue >/dev/null 2>&1 || true
    fi
    if rebase_in_progress "$VERIFY_DIR" && [ "$(rebase_position "$VERIFY_DIR")" = "$position" ]; then
      abandon_rebase
      die "rebase of $branch onto $BASE is not making progress. Rebase it by hand."
    fi
  done
  sha="$(git -C "$VERIFY_DIR" rev-parse HEAD)"
  move_branch "$branch" "$sha"
  progress "$branch: rebased onto $BASE"
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

# Every branch rebase-branches handles is built, linted and tested on its own
# before it is pushed, so a patch that upstream broke is fixed on the branch —
# where its PR sees the fix and every rebuild gets it — rather than in the
# integration. A tip that passed is not verified again, so a re-run after a
# failure only verifies what is left.

# $1 is the branch, $2 its tip before the rebase.
verify_branch() {
  local branch="$1" since sha
  [ "$verify" -eq 1 ] || return 0
  sha="$(git rev-parse "$branch")"
  if is_verified "$sha"; then
    progress "verify $branch: $(short "$sha") passed before"
    return 0
  fi
  section "🧪" "Verify $branch"
  since="$(verified_since "${2:-}")"
  open_verify_dir "$sha"
  if ! run_verify "$VERIFY_DIR" "$since"; then
    progress "$branch: does not build — $VERIFY_LOG"
    if [ "$use_agent" -eq 0 ] ||
      ! fix_with_agent "$VERIFY_DIR" "$branch" "$(branch_fix_context "$branch")" ||
      ! run_verify "$VERIFY_DIR" "$since"; then
      stop_on_branch_failure "$branch"
    fi
    move_branch "$branch" "$(git -C "$VERIFY_DIR" rev-parse HEAD)"
    progress "$branch now carries the fix"
  fi
  record_verified
}

branch_fix_context() {
  local branch="$1"
  cat <<CONTEXT
Context: '$branch' is a branch of this fork that sits directly on '$BASE'
(upstream); HEAD is its tip, just rebased onto the current upstream. On the new
upstream it does not build, lint or pass its tests. The usual cause is an
upstream change the branch did not expect: a renamed export, a new required
argument, a moved file. Read the branch's intent from its own commits:
git log $BASE..HEAD -- <file>. The files it changes:
$(git diff --name-only "$BASE...$branch" | sed 's/^/  /')

Your commit becomes part of '$branch' and of its upstream PR, so keep it to
what the branch needs. If a failure also happens on $BASE without the branch
(check in a scratch worktree of $BASE, not with git stash), it is upstream's
own: do not fix it; stop without committing and say so.
CONTEXT
}

stop_on_branch_failure() {
  local branch="$1" attempt
  attempt="$(git -C "$VERIFY_DIR" rev-parse HEAD)"
  git -C "$VERIFY_DIR" checkout -q -- . 2>/dev/null || true
  [ "$attempt" = "$(git rev-parse "$branch")" ] || say "the agent's unfinished attempt is at $(short "$attempt"): git log $branch..$attempt"
  die "$branch does not build, lint or pass its tests on $BASE, so it was not pushed.
The output is in $VERIFY_LOG."
}

# Each branch is rebased, verified and pushed by its own job, FORK_JOBS at a
# time, in its own slot: a persistent checkout that keeps node_modules and
# build outputs like the verify checkout, which is slot 1. At most
# FORK_VERIFY_JOBS of them build and test at once; the rest are rebasing or
# waiting on an agent. A job that fails does not stop the others. The
# integration is rebuilt only when every job passed.

slot_dir() {
  if [ "$1" -eq 1 ]; then echo "$WORK_ROOT/verify"; else echo "$WORK_ROOT/verify-$1"; fi
}
job_log() { echo "$JOB_DIR/${1//\//__}.log"; }

# One line to the terminal the run started from, and the same in the job's log.
progress() {
  say "$*"
  [ "$JOB" -eq 0 ] || say "$*" >&3
}

VERIFY_LOCK=""
take_verify_lock() {
  local i
  while :; do
    for ((i = 1; i <= FORK_VERIFY_JOBS; i++)); do
      if mkdir "$JOB_DIR/verify-lock-$i" 2>/dev/null; then
        VERIFY_LOCK="$JOB_DIR/verify-lock-$i"
        return 0
      fi
    done
    sleep 2
  done
}
release_verify_lock() {
  [ -z "$VERIFY_LOCK" ] || rmdir "$VERIFY_LOCK" 2>/dev/null || true
  VERIFY_LOCK=""
}

# $1 is the branch, $2 its slot, $3 its tip before the rebase. Runs in a
# subshell with stdout and stderr in the job's log; fd 3 is the terminal.
branch_job() {
  local branch="$1"
  JOB=1 JOB_AGENT="" JOB_BRANCH="$1"
  VERIFY_DIR="$(slot_dir "$2")"
  VERIFY_LOG="$JOB_DIR/${branch//\//__}.verify.log"
  trap release_verify_lock EXIT
  # Background subshells ignore SIGINT unless they trap it.
  trap 'exit 130' INT
  if git merge-base --is-ancestor "$BASE" "$branch"; then
    say "rebase $branch: already on $BASE"
  else
    rebase_branch "$branch"
  fi
  verify_branch "$branch" "$3"
  check_stopped
  publish_branch "$branch"
}

# $@ is "<branch> <tip before the rebase>" per job.
run_branch_jobs() {
  local -A branch_of=() slot_of=() started=()
  local free=() failed=() job branch old slot pid status now
  for ((slot = FORK_JOBS; slot >= 1; slot--)); do free+=("$slot"); done
  rm -rf "$JOB_DIR"
  mkdir -p "$JOB_DIR"
  rm -f "$AGENT_LIST"
  git worktree prune
  trap 'stop_branch_jobs "${!branch_of[@]}"; exit 130' INT TERM
  say "$# branches, $FORK_JOBS at a time — logs in $JOB_DIR"
  for job in "$@" ""; do
    # Wait for a free slot, and after the last job for all of them.
    while { [ -n "$job" ] && [ "${#free[@]}" -eq 0 ]; } || { [ -z "$job" ] && [ "${#branch_of[@]}" -gt 0 ]; }; do
      status=0
      wait -n -p pid || status=$?
      branch="${branch_of[$pid]}"
      now="$(date +%s)"
      if [ "$status" -eq 0 ]; then
        say "✓ $branch ($(((now - started[$pid] + 59) / 60)) min)"
      else
        failed+=("$branch")
        warn "✗ $branch failed — $(job_log "$branch"):"
        tail -n 30 "$(job_log "$branch")" | sed 's/^/    /' >&2
      fi
      free+=("${slot_of[$pid]}")
      unset "branch_of[$pid]" "slot_of[$pid]" "started[$pid]"
    done
    [ -n "$job" ] || break
    read -r branch old <<<"$job"
    slot="${free[-1]}"
    unset 'free[-1]'
    (branch_job "$branch" "$slot" "$old") 3>&1 >"$(job_log "$branch")" 2>&1 &
    branch_of[$!]="$branch" slot_of[$!]="$slot" started[$!]="$(date +%s)"
    say "▶ $branch in $(slot_dir "$slot") — tail -f $(job_log "$branch")"
  done
  trap - INT TERM
  [ "${#failed[@]}" -eq 0 ] && return 0
  die "${#failed[@]} of $# branches failed, so the integration was not rebuilt: ${failed[*]}
The branches that passed were pushed. Fix the others and re-run the same
command: a branch that passed is not verified again. Or re-run with --agent to
let a Paseo agent try, or with --no-verify to skip the build and tests."
}

# Ctrl-C reaches the builds a job runs as well as the job itself. A job that
# saw its build die first would take it for a failure and start an agent, so
# the stop marker goes up before anything is killed, each job is frozen
# before its children are, and the agents are stopped last, once no job is
# left to start another.
stop_branch_jobs() {
  local pid
  say "stopping — the branches not pushed yet stay as they were"
  touch "$JOB_DIR/stopped"
  for pid in "$@"; do kill_tree "$pid"; done
  stop_agents
}
kill_tree() {
  local child
  kill -STOP "$1" 2>/dev/null || return 0
  for child in $(pgrep -P "$1" 2>/dev/null || true); do kill_tree "$child"; done
  kill -TERM "$1" 2>/dev/null || true
  kill -CONT "$1" 2>/dev/null || true
}

rebase_patch_branches() {
  local ref local_branch i jobs=()
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
    jobs+=("$local_branch $(git rev-parse "$local_branch")")
  done
  [ "${#jobs[@]}" -eq 0 ] || run_branch_jobs "${jobs[@]}"
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
  section "🌿" "Rebase patch branches"
  assert_no_stopped_run
  local locals=()
  mapfile -t locals < <(local_patch_branches)
  assert_movable "$TOOLING_REF" "$INTEGRATION_REF" "$TARGET" ${locals[@]+"${locals[@]}"}
  validate_refs
  [ "$use_agent" -eq 0 ] || command -v paseo >/dev/null 2>&1 || die "--agent needs the paseo CLI on PATH"
  rebase_patch_branches
  cmd_rebuild
}

# ----------------------------------------------------------------- main ----

if [ "$fetch" -eq 1 ]; then
  section "📡" "Fetch remotes"
  say "Fetching $UPSTREAM_REMOTE and $FORK_REMOTE"
  git fetch --prune "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH"
  git fetch --prune "$FORK_REMOTE"
fi

BASE="$UPSTREAM_REMOTE/$UPSTREAM_BRANCH"
git rev-parse --verify -q "$BASE^{commit}" >/dev/null || die "cannot resolve $BASE"
[ "$refresh_upstream" -eq 0 ] || assert_movable "$UPSTREAM_REF"
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
rm -f "$AGENT_LIST"
section "🧭" "Run $cmd"
say "Base: $BASE ($(git log -1 --format='%h %s' "$BASE"))"

case "$cmd" in
  rebase) cmd_rebase ;;
  add) cmd_add ;;
  rebuild) cmd_rebuild ;;
  rebase-branches) cmd_rebase_branches ;;
esac
