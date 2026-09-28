#!/usr/bin/env bash
#
# fork/verify.sh <dir> <base> — build, lint and test a fork tree.
#
# fork/integrate.sh runs this on every branch rebase-branches rebases, and in
# its scratch worktree after the merges and before it stamps a build, so a
# patch that no longer fits upstream's code stops the run instead of reaching
# main. <base> is the upstream commit the tree sits on; the tests that run are
# the ones the fork touches relative to it, never the whole suite, which is
# too heavy to run here.
#
#   1. npm install
#   2. npm run build:server   the daemon packages, as fork/build.sh daemon builds them
#   3. npm run typecheck      every workspace, the app and desktop included
#   4. npm run lint
#   5. vitest on every test file the fork changes, plus the test next to
#      every source file it changes. Browser and e2e tests are skipped.
#
# Every step after the install runs even when an earlier one fails, so the log
# shows every failure at once. Tracked files the steps rewrite (the lockfile,
# generated validators) are restored at the end, so the worktree is left as
# clean as it came.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=fork/config.sh
. "$HERE/config.sh"

[ $# -eq 2 ] || die "usage: fork/verify.sh <dir> <base>"
dir="$(cd "$1" && pwd)" base="$2"
cd "$dir"
trap 'git checkout -q -- . 2>/dev/null || true' EXIT

step() { section "🧪" "$*"; }
failures=()

step "npm install"
npm install --no-audit --no-fund

step "npm run build:server"
npm run build:server || failures+=("npm run build:server")

step "npm run typecheck"
npm run typecheck || failures+=("npm run typecheck")

step "npm run lint"
npm run lint || failures+=("npm run lint")

# The test files to run: changed tests, and the sibling test of a changed
# source file. Only packages with a vitest config; browser and e2e tests need
# a browser, a daemon or a real provider.
fork_tests() {
  local file candidate ext
  git diff --name-only --diff-filter=d "$(git merge-base "$base" HEAD)" HEAD -- 'packages/*' |
    while IFS= read -r file; do
      case "$file" in
        *.test.ts | *.test.tsx) echo "$file" ;;
        *.ts | *.tsx)
          ext="${file##*.}"
          candidate="${file%.*}.test.$ext"
          [ -f "$candidate" ] && echo "$candidate"
          ;;
      esac
    done |
    grep -Ev '\.(browser|e2e)\.test\.tsx?$|/e2e/' |
    sort -u || true
}

mapfile -t tests < <(fork_tests)
packages=()
for file in ${tests[@]+"${tests[@]}"}; do
  pkg="$(echo "$file" | cut -d/ -f1-2)"
  compgen -G "$pkg/vitest.config.*" >/dev/null || continue
  [[ " ${packages[*]-} " == *" $pkg "* ]] || packages+=("$pkg")
done

for pkg in ${packages[@]+"${packages[@]}"}; do
  files=()
  for file in "${tests[@]}"; do
    [[ "$file" == "$pkg/"* ]] && files+=("${file#"$pkg"/}")
  done
  step "vitest: $pkg (${#files[@]} files)"
  (cd "$pkg" && "$dir/node_modules/.bin/vitest" run --maxWorkers=2 "${files[@]}") ||
    failures+=("vitest in $pkg")
done
[ "${#packages[@]}" -gt 0 ] || say "no fork-touched tests to run"
[ "${#failures[@]}" -eq 0 ] || die "failed: $(printf '%s; ' "${failures[@]}")"
say "build, typecheck, lint and tests pass"
