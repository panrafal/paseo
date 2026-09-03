#!/usr/bin/env bash
#
# fork/new-branch.sh — start a patch branch on the right base.
#
#   fork/new-branch.sh my-change
#
# Every change to Paseo itself belongs on its own branch off upstream, so it
# stays sendable upstream and the integration branch can be thrown away and
# rebuilt. `main` in this fork is the integration branch, so the reflex
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

BASE="$UPSTREAM_REMOTE/$UPSTREAM_BRANCH"
git fetch --prune "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH"
git switch -c "$branch" "$BASE"
say "'$branch' started on $BASE ($(git log -1 --format='%h %s' "$BASE"))"
say "Add it to fork/branches on $TOOLING_REF when you want it in every build."
