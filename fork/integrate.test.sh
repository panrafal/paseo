#!/usr/bin/env bash
#
# fork/integrate.test.sh — run fork/integrate.sh against scratch repositories.
#
# Every scenario builds a throwaway upstream, fork and clone under a temp
# directory and drives the real script with FORK_WORK_ROOT pointed there, so
# nothing touches this repository, its remotes or ~/.paseo-fork. Needs git and
# node; commits in the scratch repos use whatever identity git resolves there.
#
#   fork/integrate.test.sh              run every scenario
#   fork/integrate.test.sh add seed     run the named ones
#   KEEP=1 fork/integrate.test.sh       leave the temp directory behind

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INTEGRATE="$HERE/integrate.sh"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/fork-integrate-test.XXXXXX")"
[ -n "${KEEP:-}" ] || trap 'rm -rf "$TMP"' EXIT

passed=0 failed=0 scenario=""
ok() { passed=$((passed + 1)); }
fail() {
  failed=$((failed + 1))
  printf '\033[31mFAIL\033[0m %s: %s\n' "$scenario" "$*" >&2
  if [ -f "$F/last.log" ]; then
    sed 's/^/      | /' "$F/last.log" | tail -n 25 >&2
  fi
}
assert() {
  local msg="$1"
  shift
  if "$@" >/dev/null 2>&1; then ok; else fail "$msg"; fi
}
assert_fails() {
  local msg="$1"
  shift
  if "$@" >/dev/null 2>&1; then fail "$msg (succeeded)"; else ok; fi
}
assert_eq() {
  if [ "$2" = "$3" ]; then ok; else fail "$1: expected '$3', got '$2'"; fi
}
assert_log() { # the last run's output mentions $1
  if grep -q -- "$1" "$F/last.log" 2>/dev/null; then ok; else fail "log does not mention '$1'"; fi
}

# ------------------------------------------------------------- fixture ----
# $F/upstream.git   bare, plays getpaseo/paseo
# $F/origin.git     bare, plays panrafal/paseo
# $F/repo           clone of origin with an upstream remote, on fork-base
# $F/work           FORK_WORK_ROOT
F="" R=""
fixture() {
  scenario="$1"
  F="$TMP/$1"
  R="$F/repo"
  mkdir -p "$F"
  git init -q --bare -b main "$F/upstream.git"
  git init -q --bare -b main "$F/origin.git"
  git clone -q "$F/upstream.git" "$F/seed" 2>/dev/null
  (
    cd "$F/seed"
    printf '{\n  "name": "paseo",\n  "version": "0.7.2"\n}\n' >package.json
    printf 'line 1\nline 2\nline 3\n' >a.txt
    git add -A && git commit -q -m "upstream: initial" && git push -q origin main
  )
  rm -rf "$F/seed"
  git clone -q "$F/origin.git" "$R" 2>/dev/null
  git -C "$R" remote add upstream "$F/upstream.git"
  git -C "$R" fetch -q upstream
  git -C "$R" switch -q -c fork-base upstream/main
  mkdir -p "$R/fork"
  printf '# branches merged into the integration\n' >"$R/fork/branches"
  printf '0.7.2 0\n' >"$R/fork/build-number"
  git -C "$R" add -A && git -C "$R" commit -q -m "fork: tooling"
  git -C "$R" push -q -u origin fork-base 2>/dev/null
  export FORK_WORK_ROOT="$F/work"
}

# A patch branch off upstream/main: $1 name, $2 file, $3 content. Local and
# pushed, like a real one.
patch_branch() {
  local name="$1" file="$2" content="$3"
  local wt="$F/wt-$name"
  git -C "$R" fetch -q upstream
  git -C "$R" worktree add -q --detach "$wt" upstream/main
  (
    cd "$wt"
    git switch -q -c "$name"
    printf '%s' "$content" >"$file"
    git add -A && git commit -q -m "patch: $name" && git push -q -u origin "$name" 2>/dev/null
  )
  git -C "$R" worktree remove --force "$wt"
}

# A commit on upstream main: $1 file, $2 content, $3 message.
upstream_commit() {
  local dir="$F/up-wt"
  rm -rf "$dir"
  git clone -q "$F/upstream.git" "$dir" 2>/dev/null
  (
    cd "$dir"
    printf '%s' "$2" >"$1"
    git add -A && git commit -q -m "$3" && git push -q origin main
  )
  rm -rf "$dir"
}

# Append a ref to fork/branches on fork-base, the manual route.
list_branch() {
  (
    cd "$R"
    printf '%s\n' "$1" >>fork/branches
    git add fork/branches && git commit -q -m "fork: list $1" && git push -q origin fork-base 2>/dev/null
  )
}

run() { (cd "$R" && "$INTEGRATE" "$@") >"$F/last.log" 2>&1; }
at() { git -C "$R" rev-parse "$1"; }
tree_of() { git -C "$R" rev-parse "$1^{tree}"; }
build_number() { git -C "$R" show "$1:fork/build-number"; }
first_parents() { git -C "$R" log --first-parent --format=%s "$1" | tr '\n' '|'; }

# ----------------------------------------------------------- scenarios ----

scenario_rebuild() {
  fixture rebuild
  patch_branch feat-a a.txt $'line 1 (a)\nline 2\nline 3\n'
  patch_branch feat-b b.txt 'b'
  list_branch origin/feat-a
  list_branch origin/feat-b
  assert "rebuild --push" run rebuild --push
  assert "fork-integration exists" git -C "$R" rev-parse --verify fork-integration
  assert_eq "main has fork-integration's tree" "$(tree_of main)" "$(tree_of fork-integration)"
  assert_eq "main is one commit on upstream" "$(at main^)" "$(at upstream/main)"
  assert_eq "main's subject is the build" "$(git -C "$R" log -1 --format=%s main)" "fork: build 0.7.2-panrafal.1"
  assert "main's message lists the branches" grep -q "origin/feat-b" <(git -C "$R" log -1 --format=%B main)
  assert_eq "patch a is in" "$(git -C "$R" show main:a.txt | head -1)" "line 1 (a)"
  assert "patch b is in" git -C "$R" cat-file -e main:b.txt
  assert_eq "build number" "$(build_number main)" "0.7.2 1"
  assert_eq "integration shape" "$(first_parents upstream/main..fork-integration)" \
    "fork: build 0.7.2-panrafal.1|Merge origin/feat-b into fork-integration|Merge origin/feat-a into fork-integration|Merge fork-base into fork-integration|"
  assert_eq "origin/main pushed" "$(at origin/main)" "$(at main)"
  assert_eq "origin/fork-integration pushed" "$(at origin/fork-integration)" "$(at fork-integration)"
  assert_eq "origin/fork-base pushed" "$(at origin/fork-base)" "$(at fork-base)"
  assert_eq "fork-base checkout follows" "$(git -C "$R" rev-parse HEAD)" "$(at fork-base)"
  # A rebuild with nothing new is a new history and a new number.
  assert "rebuild again" run rebuild --push
  assert_eq "second build number" "$(build_number main)" "0.7.2 2"
  # A duplicate line is refused.
  list_branch origin/feat-a
  assert_fails "duplicate line refused" run rebuild
  assert_log "more than once"
}

scenario_rebase() {
  fixture rebase
  # Upstream's own history has merges titled like ours; they are not ours.
  (
    git clone -q "$F/upstream.git" "$F/up-merge" 2>/dev/null && cd "$F/up-merge" &&
      git switch -q -c refactor/thing && echo t >t.txt && git add -A && git commit -q -m "thing" &&
      git switch -q main && git merge -q --no-ff -m "Merge refactor/thing into main" refactor/thing &&
      git push -q origin main
  )
  patch_branch feat-a a.txt $'line 1 (a)\nline 2\nline 3\n'
  list_branch origin/feat-a
  run rebuild --push
  assert_fails "upstream's merges are not reported as dropped branches" grep -q "no longer in fork/branches" "$F/last.log"
  local old_int old_main
  old_int="$(at fork-integration)"
  old_main="$(at main)"
  upstream_commit c.txt 'c' "upstream: add c"
  assert "rebase --push" run rebase --push
  assert_fails "still not after a rebase" grep -q "no longer in fork/branches" "$F/last.log"
  assert "c is in" git -C "$R" cat-file -e main:c.txt
  assert_eq "patch a survives" "$(git -C "$R" show main:a.txt | head -1)" "line 1 (a)"
  assert "integration fast-forwarded" git -C "$R" merge-base --is-ancestor "$old_int" fork-integration
  assert "integration contains upstream" git -C "$R" merge-base --is-ancestor upstream/main fork-integration
  assert_eq "main re-based onto new upstream" "$(at main^)" "$(at upstream/main)"
  assert_eq "main tree = integration tree" "$(tree_of main)" "$(tree_of fork-integration)"
  assert_eq "build 2" "$(build_number main)" "0.7.2 2"
  assert_eq "two merges since" "$(git -C "$R" rev-list --count --first-parent "$old_int..fork-integration")" "2"
  assert_eq "pushed" "$(at origin/main)" "$(at main)"
  # Nothing new: no bump, no new commits, main untouched.
  local tip_int tip_main
  tip_int="$(at fork-integration)"
  tip_main="$(at main)"
  assert "rebase no-op" run rebase --push
  assert_eq "integration unchanged" "$(at fork-integration)" "$tip_int"
  assert_eq "main unchanged" "$(at main)" "$tip_main"
  assert_eq "no bump" "$(build_number main)" "0.7.2 2"
  assert_log "nothing changed"
  # A tooling-only change on fork-base still reaches main, with a number.
  (cd "$R" && echo note >fork/note && git add fork/note && git commit -q -m "fork: note")
  assert "rebase after a fork-base commit" run rebase --push
  assert "fork/note is in" git -C "$R" cat-file -e main:fork/note
  assert_eq "build 3" "$(build_number main)" "0.7.2 3"
  # An upstream version bump restarts the counter.
  upstream_commit package.json $'{\n  "name": "paseo",\n  "version": "0.7.3"\n}\n' "upstream: 0.7.3"
  assert "rebase with a version bump" run rebase --push
  assert_eq "counter restarted" "$(build_number main)" "0.7.3 1"
  assert_log "restarting the fork counter"
}

scenario_drift() {
  fixture drift
  patch_branch feat-a a.txt $'line 1 (a)\nline 2\nline 3\n'
  patch_branch feat-b b.txt 'b'
  list_branch origin/feat-a
  list_branch origin/feat-b
  run rebuild --push
  # feat-a gains a commit: the routine rebase picks it up.
  (cd "$R" && git worktree add -q "$F/wt-a" feat-a && cd "$F/wt-a" && echo more >a2.txt && git add -A && git commit -q -m "patch: a2" && git push -q origin feat-a 2>/dev/null)
  git -C "$R" worktree remove --force "$F/wt-a"
  assert "rebase merges the extended branch" run rebase --push
  assert_log "gained commits"
  assert "a2 is in" git -C "$R" cat-file -e main:a2.txt
  assert_eq "build 2" "$(build_number main)" "0.7.2 2"
  # feat-b is rewritten (amended): the new tip is merged over the old one.
  (cd "$R" && git worktree add -q "$F/wt-b" feat-b && cd "$F/wt-b" && printf 'b2' >b.txt && git commit -q -am "patch: feat-b (amended)" --amend && git push -q -f origin feat-b 2>/dev/null)
  git -C "$R" worktree remove --force "$F/wt-b"
  assert "rebase merges the rewritten branch" run rebase --push
  assert_log "was rewritten"
  assert_eq "new content wins" "$(git -C "$R" show main:b.txt)" "b2"
  # A line removed from the list is reported, not acted on, until a rebuild.
  (cd "$R" && sed -i.bak '/feat-b/d' fork/branches && rm -f fork/branches.bak && git commit -q -am "fork: drop feat-b")
  assert "rebase after removing a line" run rebase --push
  assert_log "no longer in fork/branches"
  assert "b still in until rebuild" git -C "$R" cat-file -e main:b.txt
  assert "rebuild" run rebuild --push
  assert_fails "b gone after rebuild" git -C "$R" cat-file -e main:b.txt
  # A branch that landed upstream is flagged, even with unrelated upstream
  # commits around it.
  upstream_commit a2.txt $'more\n' "upstream: take a2"
  upstream_commit z.txt 'z' "upstream: unrelated"
  upstream_commit a.txt $'line 1 (a)\nline 2\nline 3\n' "upstream: take a"
  assert "rebase" run rebase --push
  assert_log "origin/feat-a looks merged upstream"
  # One merged upstream with a merge commit too.
  patch_branch feat-m m.txt 'm'
  assert "add feat-m" run add feat-m --push
  (
    cd "$F/up-wt-m" 2>/dev/null || git clone -q "$F/upstream.git" "$F/up-wt-m" 2>/dev/null
    cd "$F/up-wt-m" && git fetch -q "$F/origin.git" feat-m && git merge -q --no-ff -m "Merge feat-m" FETCH_HEAD && git push -q origin main
  )
  assert "rebase" run rebase --push
  assert_log "origin/feat-m looks merged upstream"
  # A branch cut from main, listed by hand, is refused by rebase and rebuild.
  git -C "$R" branch -q bad main
  git -C "$R" push -q origin bad 2>/dev/null
  list_branch origin/bad
  assert_fails "rebase refuses a branch cut from main" run rebase
  assert_log "carries fork/branches"
  assert_fails "rebuild refuses it too" run rebuild
  assert_log "carries fork/branches"
}

scenario_add() {
  fixture add
  patch_branch feat-a a.txt $'line 1 (a)\nline 2\nline 3\n'
  list_branch origin/feat-a
  run rebuild --push
  local old_int
  old_int="$(at fork-integration)"
  patch_branch feat-c c.txt 'c'
  assert "add feat-c --push" run add feat-c --push
  assert_eq "listed last" "$(git -C "$R" show fork-base:fork/branches | tail -1)" "origin/feat-c"
  assert "c is in" git -C "$R" cat-file -e main:c.txt
  assert_eq "main tree = integration tree" "$(tree_of main)" "$(tree_of fork-integration)"
  assert_eq "build 2" "$(build_number main)" "0.7.2 2"
  assert_eq "shape" "$(first_parents "$old_int..fork-integration")" "fork: build 0.7.2-panrafal.2|Merge origin/feat-c into fork-integration|"
  assert_eq "pushed" "$(at origin/fork-integration)" "$(at fork-integration)"
  assert_fails "add again refused" run add origin/feat-c
  assert_log "already listed"
  # Unpushed local commits: push first.
  (cd "$R" && git worktree add -q "$F/wt-c" feat-c && cd "$F/wt-c" && echo x >x.txt && git add -A && git commit -q -m "patch: local only")
  git -C "$R" worktree remove --force "$F/wt-c"
  assert_fails "local ahead of origin refused" run add feat-c
  assert_log "push it first"
  git -C "$R" branch -q -f feat-c origin/feat-c
  # A branch cut from main carries fork/branches: refused.
  git -C "$R" branch -q bad main
  assert_fails "branch cut from main refused" run add bad
  assert_log "carries fork/branches"
  assert_fails "unknown branch refused" run add nope
  # Listed by hand but never merged: add merges it without re-listing.
  patch_branch feat-d d.txt 'd'
  list_branch origin/feat-d
  assert "add a hand-listed branch" run add feat-d --push
  assert_eq "listed once" "$(git -C "$R" show fork-base:fork/branches | grep -c feat-d)" "1"
  assert "d is in" git -C "$R" cat-file -e main:d.txt
  # Both spellings resolve to the same ref.
  patch_branch feat-e e.txt 'e'
  assert "add origin/<name>" run add origin/feat-e
  assert_eq "recorded as origin/feat-e" "$(git -C "$R" show fork-base:fork/branches | tail -1)" "origin/feat-e"
}

scenario_conflict() {
  fixture conflict
  patch_branch feat-a a.txt $'line 1 (a)\nline 2\nline 3\n'
  list_branch origin/feat-a
  run rebuild --push
  local old_int
  old_int="$(at fork-integration)"
  upstream_commit a.txt $'line 1 (up)\nline 2\nline 3\n' "upstream: change line 1"
  assert_fails "rebase stops on the conflict" run rebase --push
  assert_log "conflict"
  local wt="$FORK_WORK_ROOT/integrate"
  assert "worktree left with MERGE_HEAD" git -C "$wt" rev-parse -q --verify MERGE_HEAD
  assert_eq "integration untouched" "$(at fork-integration)" "$old_int"
  assert_eq "no bump while stopped" "$(build_number fork-base)" "0.7.2 1"
  assert_fails "a second run refuses while stopped" run rebase
  assert_log "stopped on a conflict"
  # Resolve by hand, with an edit outside the conflict hunk that rerere would
  # not carry, then re-run: the finished merge is adopted as-is.
  printf 'line 1 (a+up)\nline 2\nline 3 (fixed up)\n' >"$wt/a.txt"
  git -C "$wt" add a.txt && git -C "$wt" commit -q --no-edit 2>/dev/null
  assert "re-run continues" run rebase --push
  assert_log "continuing from the merge"
  assert_eq "resolution kept" "$(git -C "$R" show main:a.txt | head -1)" "line 1 (a+up)"
  assert_eq "out-of-hunk edit kept" "$(git -C "$R" show main:a.txt | tail -1)" "line 3 (fixed up)"
  assert_eq "build 2" "$(build_number main)" "0.7.2 2"
  assert_eq "main on new upstream" "$(at main^)" "$(at upstream/main)"
  # Abandoning a stopped run.
  upstream_commit a.txt $'line 1 (up2)\nline 2\nline 3 (fixed up)\n' "upstream: change line 1 again"
  assert_fails "stops again" run rebase
  git worktree remove --force "$wt" 2>/dev/null || git -C "$R" worktree remove --force "$wt"
  assert_fails "still conflicts after abandoning" run rebase
  assert_log "conflict"
}

scenario_conflict_add() {
  fixture conflict-add
  patch_branch feat-a a.txt $'line 1 (a)\nline 2\nline 3\n'
  list_branch origin/feat-a
  run rebuild --push
  patch_branch feat-x a.txt $'line 1 (x)\nline 2\nline 3\n'
  assert_fails "add stops on the conflict" run add feat-x --push
  assert_eq "fork-base untouched by a stopped add" "$(git -C "$R" show fork-base:fork/branches | grep -c feat-x)" "0"
  assert_eq "origin/fork-base untouched" "$(at origin/fork-base)" "$(at fork-base)"
  local wt="$FORK_WORK_ROOT/integrate"
  printf 'line 1 (a+x)\nline 2\nline 3\n' >"$wt/a.txt"
  git -C "$wt" add a.txt && git -C "$wt" commit -q --no-edit 2>/dev/null
  assert "re-run add continues" run add feat-x --push
  assert_log "continuing from the merge"
  assert_eq "listed after success" "$(git -C "$R" show fork-base:fork/branches | tail -1)" "origin/feat-x"
  assert_eq "resolution kept" "$(git -C "$R" show main:a.txt | head -1)" "line 1 (a+x)"
  # A merge left by a stopped `add x` is not picked up by `add y`.
  patch_branch feat-z a.txt $'line 1 (z)\nline 2\nline 3\n'
  patch_branch feat-y y.txt 'y'
  assert_fails "add feat-z stops" run add feat-z
  printf 'line 1 (a+x+z)\nline 2\nline 3\n' >"$wt/a.txt"
  git -C "$wt" add a.txt && git -C "$wt" commit -q --no-edit 2>/dev/null
  assert "add feat-y" run add feat-y --push
  assert_log "discarding the worktree"
  assert_eq "feat-z's merge not published" "$(git -C "$R" show main:a.txt | head -1)" "line 1 (a+x)"
  assert "y is in" git -C "$R" cat-file -e main:y.txt
  assert_eq "only feat-y listed" "$(git -C "$R" show fork-base:fork/branches | grep -c 'feat-[yz]')" "1"
}

scenario_rebase_branches() {
  fixture rebase-branches
  patch_branch feat-a a.txt $'line 1 (a)\nline 2\nline 3\n'
  patch_branch feat-b b.txt 'b'
  list_branch origin/feat-a
  list_branch origin/feat-b
  run rebuild --push
  local old_main
  old_main="$(at main)"
  upstream_commit c.txt 'c' "upstream: add c"
  assert "rebase-branches --push" run rebase-branches --push
  assert "feat-a on new upstream" git -C "$R" merge-base --is-ancestor upstream/main feat-a
  assert "feat-b on new upstream" git -C "$R" merge-base --is-ancestor upstream/main feat-b
  assert "fork-base on new upstream" git -C "$R" merge-base --is-ancestor upstream/main fork-base
  assert_eq "feat-a pushed" "$(at origin/feat-a)" "$(at feat-a)"
  assert_eq "feat-b pushed" "$(at origin/feat-b)" "$(at feat-b)"
  assert_eq "fork-base pushed" "$(at origin/fork-base)" "$(at fork-base)"
  assert "c is in" git -C "$R" cat-file -e main:c.txt
  assert "b is in" git -C "$R" cat-file -e main:b.txt
  assert_eq "integration rebuilt on upstream" "$(first_parents upstream/main..fork-integration | cut -d'|' -f4)" "Merge fork-base into fork-integration"
  assert_eq "main on new upstream" "$(at main^)" "$(at upstream/main)"
  assert_eq "build 2" "$(build_number main)" "0.7.2 2"
  assert_fails "main is rewritten, not advanced" git -C "$R" merge-base --is-ancestor "$old_main" main
  assert_log "Compared with the previous"
  # The last listed branch with no local copy is merged as-is, and the run
  # still rebuilds.
  git -C "$R" branch -q -D feat-b
  upstream_commit c2.txt 'c2' "upstream: add c2"
  assert "rebase-branches with a remote-only last entry" run rebase-branches --push
  assert_log "no local branch 'feat-b'"
  assert "c2 is in" git -C "$R" cat-file -e main:c2.txt
  assert "b is still in" git -C "$R" cat-file -e main:b.txt
  assert_eq "build 3" "$(build_number main)" "0.7.2 3"
  # A local branch behind its published copy is caught up before the rebase.
  local R2="$F/repo2"
  git clone -q "$F/origin.git" "$R2" 2>/dev/null
  (cd "$R2" && git switch -q -c feat-a origin/feat-a && echo a3 >a3.txt && git add -A && git commit -q -m "patch: a3 from elsewhere" && git push -q origin feat-a 2>/dev/null)
  upstream_commit c3.txt 'c3' "upstream: add c3"
  assert "rebase-branches with a stale local branch" run rebase-branches --push
  assert_log "feat-a: fast-forwarded to origin/feat-a"
  assert "a3 survives in main" git -C "$R" cat-file -e main:a3.txt
  assert "a3 survives on origin/feat-a" git -C "$R" cat-file -e origin/feat-a:a3.txt
  # A dirty checkout of a patch branch stops the run before anything is pushed.
  git -C "$R" worktree add -q "$F/wt-a" feat-a
  echo dirty >>"$F/wt-a/a.txt"
  upstream_commit c4.txt 'c4' "upstream: add c4"
  local tip_a
  tip_a="$(at origin/feat-a)"
  assert_fails "dirty patch checkout refused" run rebase-branches --push
  assert_log "uncommitted changes"
  assert_eq "nothing pushed" "$(at origin/feat-a)" "$tip_a"
  git -C "$R" worktree remove --force "$F/wt-a"
  # A rebase that conflicts stops without --agent and leaves the branch alone.
  git -C "$R" branch -q feat-b origin/feat-b
  upstream_commit b.txt 'upstream b' "upstream: b"
  local tip_b
  tip_b="$(at feat-b)"
  assert_fails "conflicting rebase stops" run rebase-branches
  assert_log "stopped on a conflict"
  assert_eq "feat-b untouched" "$(at feat-b)" "$tip_b"
  assert_fails "no rebase worktree left" test -e "$FORK_WORK_ROOT/rebase"
}

scenario_seed() {
  fixture seed
  patch_branch feat-a a.txt $'line 1 (a)\nline 2\nline 3\n'
  list_branch origin/feat-a
  assert_fails "rebase before any integration exists" run rebase
  assert_log "no fork-integration yet"
  run rebuild --push
  # A second clone with only main and fork-base picks the integration up.
  local R2="$F/repo2"
  git clone -q "$F/origin.git" "$R2" 2>/dev/null
  git -C "$R2" remote add upstream "$F/upstream.git"
  git -C "$R2" fetch -q origin fork-base:fork-base
  upstream_commit c.txt 'c' "upstream: c"
  local saved="$R"
  R="$R2"
  export FORK_WORK_ROOT="$F/work2"
  assert "rebase in the clone" run rebase --push
  assert_log "started from origin/fork-integration"
  assert "c is in" git -C "$R2" cat-file -e main:c.txt
  assert_eq "main checkout follows" "$(git -C "$R2" rev-parse HEAD)" "$(git -C "$R2" rev-parse main)"
  assert_eq "build 2" "$(git -C "$R2" show main:fork/build-number)" "0.7.2 2"
  # Without a published integration, main seeds it.
  git -C "$R2" push -q origin --delete fork-integration 2>/dev/null
  git -C "$R2" branch -q -D fork-integration
  upstream_commit d.txt 'd' "upstream: d"
  assert "rebase seeds from origin/main" run rebase --push
  assert_log "started from origin/main"
  assert "d is in" git -C "$R2" cat-file -e main:d.txt
  assert_eq "patch a still in" "$(git -C "$R2" show main:a.txt | head -1)" "line 1 (a)"
  assert "restored integration knows feat-a" git -C "$R2" merge-base --is-ancestor origin/feat-a fork-integration
  assert_eq "build 3" "$(git -C "$R2" show main:fork/build-number)" "0.7.2 3"
  R="$saved"
}

scenario_diverged() {
  fixture diverged
  patch_branch feat-a a.txt $'line 1 (a)\nline 2\nline 3\n'
  list_branch origin/feat-a
  run rebuild --push
  # Another checkout advanced fork-integration: this one fast-forwards.
  local R2="$F/repo2"
  git clone -q "$F/origin.git" "$R2" 2>/dev/null
  git -C "$R2" remote add upstream "$F/upstream.git"
  git -C "$R2" fetch -q origin fork-base:fork-base
  upstream_commit c.txt 'c' "upstream: c"
  (cd "$R2" && FORK_WORK_ROOT="$F/work2" "$INTEGRATE" rebase --push >"$F/other.log" 2>&1) || { fail "other checkout's rebase failed"; cat "$F/other.log" >&2; }
  upstream_commit d.txt 'd' "upstream: d"
  assert "rebase fast-forwards to the published integration" run rebase --push
  assert_log "fast-forwarded to origin/fork-integration"
  assert "c is in" git -C "$R" cat-file -e main:c.txt
  assert "d is in" git -C "$R" cat-file -e main:d.txt
  # A diverged fork-integration is fatal, and nothing is pushed.
  (cd "$R2" && git fetch -q origin && git branch -q -f fork-integration origin/fork-integration~1 && echo z >"$R2/z.txt")
  local remote_int
  remote_int="$(at origin/fork-integration)"
  git -C "$R2" branch -q -f fork-integration "$(git -C "$R2" commit-tree "origin/fork-integration~1^{tree}" -p "origin/fork-integration~1" -m "stray")"
  assert_fails "diverged integration refused" bash -c "cd '$R2' && FORK_WORK_ROOT='$F/work2' '$INTEGRATE' rebase --push"
  assert_eq "remote integration untouched" "$(at origin/fork-integration)" "$remote_int"
  # A run without --push, then a run with it, publishes the same thing.
  upstream_commit e.txt 'e' "upstream: e"
  assert "rebase without --push" run rebase
  assert_log "Not pushed"
  assert_fails "not on origin yet" git -C "$R" cat-file -e origin/main:e.txt
  assert "rebase --push publishes it" run rebase --push
  assert_eq "no extra bump for the publish" "$(build_number main)" "0.7.2 4"
  assert "e is on origin" git -C "$R" cat-file -e origin/main:e.txt
  assert_fails "no false 'made by hand' warning" grep -q "made by hand" "$F/last.log"
}

scenario_dirty() {
  fixture dirty
  patch_branch feat-a a.txt $'line 1 (a)\nline 2\nline 3\n'
  list_branch origin/feat-a
  run rebuild --push
  git -C "$R" worktree add -q "$F/main-wt" main
  echo dirty >>"$F/main-wt/a.txt"
  upstream_commit c.txt 'c' "upstream: c"
  local before_int before_bn
  before_int="$(at fork-integration)"
  before_bn="$(build_number fork-base)"
  assert_fails "refuses with a dirty main checkout" run rebase --push
  assert_log "uncommitted changes"
  assert_eq "integration untouched" "$(at fork-integration)" "$before_int"
  assert_eq "no bump" "$(build_number fork-base)" "$before_bn"
  git -C "$F/main-wt" checkout -q -- a.txt
  assert "runs once clean" run rebase --push
  assert_eq "main worktree reset" "$(git -C "$F/main-wt" rev-parse HEAD)" "$(at main)"
  # A commit made by hand on main is dropped with a warning.
  (cd "$F/main-wt" && echo stray >stray.txt && git add stray.txt && git commit -q -m "oops on main")
  upstream_commit d.txt 'd' "upstream: d"
  assert "rebase drops it" run rebase --push
  assert_log "made by hand"
  assert_fails "stray commit gone" git -C "$R" cat-file -e main:stray.txt
}

scenario_args() {
  fixture args
  assert_fails "no command" run
  assert_fails "unknown flag" run rebase --bogus
  assert_fails "two commands" run rebase rebuild
  assert_fails "add without a branch" run add
  assert "help" run --help
  assert_log "rebase-branches"
  assert "--no-fetch works without a remote round trip" run rebuild --no-fetch
  # An indented line in fork/branches is a line like any other.
  patch_branch feat-a a.txt $'line 1 (a)\nline 2\nline 3\n'
  list_branch "   origin/feat-a"
  assert "rebuild with an indented line" run rebuild
  assert_eq "patch a is in" "$(git -C "$R" show main:a.txt | head -1)" "line 1 (a)"
  assert "main's message lists it with an id" grep -qE "^  origin/feat-a [0-9a-f]{40}\$" <(git -C "$R" log -1 --format=%B main)
}

# ---------------------------------------------------------------- run ----

all=(rebuild rebase drift add conflict conflict_add rebase_branches seed diverged dirty args)
names=("${@:-${all[@]}}")
for name in "${names[@]}"; do
  name="${name//-/_}"
  printf '\033[1m--> %s\033[0m\n' "$name"
  "scenario_$name"
done
echo
if [ "$failed" -eq 0 ]; then
  printf '\033[32m%d assertions passed\033[0m\n' "$passed"
else
  printf '\033[31m%d failed\033[0m, %d passed\n' "$failed" "$passed"
  exit 1
fi
