#!/usr/bin/env bash
#
# fork/new-branch.sh — start a patch branch on the right base.
#
#   fork/new-branch.sh my-change
#
# Every change to Paseo itself belongs on its own branch off fork-upstream, so it
# stays sendable upstream and merges into the integration branch on its own.
# `main` in this fork is the published integration, so the reflex
# `git switch -c my-change` bases the work on the whole patch stack instead.
#
# See fork/README.md.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=fork/config.sh
. "$HERE/config.sh"

[ $# -eq 1 ] || die "usage: fork/new-branch.sh <branch-name>"
branch="$1"

require_repo
git show-ref --verify -q "refs/heads/$branch" && die "branch '$branch' already exists"

BASE="$UPSTREAM_REF"
git show-ref --verify -q "refs/heads/$BASE" ||
  die "base branch '$BASE' not found — run fork/integrate.sh rebase --push first"
git switch --no-track -c "$branch" "$BASE"
say "'$branch' started on $BASE ($(git log -1 --format='%h %s' "$BASE"))"
say "When it is pushed, put it in every build with: fork/integrate.sh add $branch --push"
