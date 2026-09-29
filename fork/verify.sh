#!/usr/bin/env bash
#
# fork/verify.sh <dir> <base> [<since>] — build, lint and test a fork tree.
#
# fork/integrate.sh runs this on every branch rebase-branches rebases, and on
# the merged integration before it stamps a build, so a patch that no longer
# fits upstream's code stops the run instead of reaching main. <base> is the
# upstream commit the tree sits on. <since>, when given, is a commit that
# passed this check before.
#
# Only what the fork can have broken is checked: fork/verify-scope.mjs picks
# the workspaces the fork changes relative to <base>, plus their dependents,
# and of those only the ones that changed since <since>. Upstream's own code
# is upstream's CI's job, and the full suite is too heavy to run here.
#
#   1. npm install, skipped when the manifests and lockfile match the last
#      install in <dir>
#   2. npm run build of each workspace a checked one reads from dist/, skipped
#      when its output in <dir> was built from the same inputs
#   3. npm run typecheck of each checked workspace
#   4. npm run lint, all of it: oxlint takes seconds
#   5. vitest on every test file the fork changes in a checked workspace,
#      plus the test next to every source file it changes there. Browser and
#      e2e tests are skipped.
#
# Every step after the install runs even when an earlier one fails, so the log
# shows every failure at once. Tracked files the steps rewrite (the lockfile,
# generated validators) are restored at the end, so the worktree is left as
# clean as it came.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=fork/config.sh
. "$HERE/config.sh"

[ $# -eq 2 ] || [ $# -eq 3 ] || die "usage: fork/verify.sh <dir> <base> [<since>]"
dir="$(cd "$1" && pwd)" base="$2" since="${3:-}"
cd "$dir"
trap 'git checkout -q -- . 2>/dev/null || true' EXIT

step() { section "🧪" "$*"; }
failures=()

# Everything npm install reads, as one hash: every package.json, the lockfile,
# the patches postinstall applies, and the node that runs it.
install_key() {
  {
    node --version
    git ls-tree -r HEAD | grep -E $'\t((.*/)?package(-lock)?\\.json|\\.npmrc|patches/.*|scripts/postinstall.*)$'
  } | git hash-object --stdin
}

INSTALL_STAMP="node_modules/.fork-verify-install"
key="$(install_key)"
step "npm install"
if [ "$(cat "$INSTALL_STAMP" 2>/dev/null || true)" = "$key" ]; then
  say "manifests and lockfile unchanged since the last install here — skipped"
else
  rm -f "$INSTALL_STAMP"
  npm install --no-audit --no-fund
  echo "$key" >"$INSTALL_STAMP"
fi

step "scope"
scope="$(node "$HERE/verify-scope.mjs" "$base" ${since:+"$since"})"
sed -n 's/^note //p' <<<"$scope" | while IFS= read -r line; do say "$line"; done
mapfile -t builds < <(sed -n 's/^build //p' <<<"$scope")
mapfile -t typechecks < <(sed -n 's/^typecheck //p' <<<"$scope")
mapfile -t tests < <(sed -n 's/^test //p' <<<"$scope")

# A build's output is kept while its inputs match the key it was built from;
# the stamps live in node_modules, which every checkout of <dir> keeps.
BUILD_STAMPS="node_modules/.fork-verify-builds"
mkdir -p "$BUILD_STAMPS"
for line in ${builds[@]+"${builds[@]}"}; do
  read -r ws build_key outputs <<<"$line"
  stamp="$BUILD_STAMPS/${ws//\//__}"
  step "npm run build --workspace=$ws"
  if [ "$(cat "$stamp" 2>/dev/null || true)" = "$build_key $key" ]; then
    say "inputs unchanged since its last build here — skipped"
    continue
  fi
  rm -f "$stamp"
  # shellcheck disable=SC2086 # the output dirs, space-separated
  rm -rf $outputs
  if npm run build --workspace="$ws"; then
    echo "$build_key $key" >"$stamp"
  else
    failures+=("build of $ws")
  fi
done

for ws in ${typechecks[@]+"${typechecks[@]}"}; do
  step "npm run typecheck --workspace=$ws"
  npm run typecheck --workspace="$ws" || failures+=("typecheck of $ws")
done

step "npm run lint"
npm run lint || failures+=("npm run lint")

packages=()
for line in ${tests[@]+"${tests[@]}"}; do
  pkg="${line%% *}"
  [[ " ${packages[*]-} " == *" $pkg "* ]] || packages+=("$pkg")
done
for pkg in ${packages[@]+"${packages[@]}"}; do
  files=()
  for line in "${tests[@]}"; do
    [ "${line%% *}" = "$pkg" ] && files+=("${line#* }")
  done
  step "vitest: $pkg (${#files[@]} files)"
  (cd "$pkg" && "$dir/node_modules/.bin/vitest" run --maxWorkers=2 "${files[@]}") ||
    failures+=("vitest in $pkg")
done
[ "${#packages[@]}" -gt 0 ] || say "no fork-touched tests to run"
[ "${#failures[@]}" -eq 0 ] || die "failed: $(printf '%s; ' "${failures[@]}")"
say "build, typecheck, lint and tests pass"
