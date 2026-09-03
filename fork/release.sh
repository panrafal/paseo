#!/usr/bin/env bash
#
# fork/release.sh — cut a fork build of the desktop app.
#
# Tags the current `main` commit as `fork-v<version>` and pushes it, which
# starts the fork's own Desktop workflow on GitHub. That workflow builds,
# signs and notarizes the macOS app on a macos runner and publishes it to a
# GitHub Release on your fork, with an auto-update feed pointing at your fork
# rather than upstream.
#
# Commands:
#   fork/release.sh desktop [<version>]   tag + push, then watch the build
#   fork/release.sh status                show the latest fork release
#   fork/release.sh watch                 follow the running workflow
#
# The version is fork_version() from fork/config.sh — the same string the
# daemon and iOS builds carry, so artifacts from one commit all agree.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=fork/config.sh
. "$HERE/config.sh"
# shellcheck source=fork/dist.env
set -a
. "$HERE/dist.env"
set +a

REPO="$FORK_GH_OWNER/$FORK_GH_REPO"
cmd="${1:-desktop}"
explicit_version="${2:-}"

command -v gh >/dev/null 2>&1 || die "the gh CLI is required"

case "$cmd" in
  desktop)
    require_repo
    git rev-parse --verify -q "$TARGET^{commit}" >/dev/null || die "branch '$TARGET' does not exist"
    git fetch --tags --quiet "$FORK_REMOTE"
    version="${explicit_version:-$(fork_version)}"
    tag="fork-v$version"
    sha="$(git rev-parse "$TARGET")"

    git rev-parse -q --verify "refs/tags/$tag" >/dev/null && die "tag $tag already exists"
    # The workflow builds whatever the tag points at, so the branch must be
    # published first or the runner cannot check the commit out.
    git push --force-with-lease "$FORK_REMOTE" "$TARGET:$TARGET"
    git tag -a "$tag" "$sha" -m "Fork build $version from $TARGET"
    git push "$FORK_REMOTE" "$tag"
    say "Tagged $tag at $(git log -1 --format='%h %s' "$sha")"
    say "Desktop build started: https://github.com/$REPO/actions"
    echo
    echo "When it finishes, update the Mac with:"
    echo "    fork/update-macos.sh          # run this on the laptop"
    echo "  or let the app's built-in updater find it — the feed now points at $REPO."
    # The run record shows up a few seconds after the tag push. Asking for the
    # latest run right away returns the previous one, which "watch" reports
    # as finished at once — so find the run by its tag, then wait for it.
    run_id=""
    for _ in $(seq 1 30); do
      run_id="$(gh run list --repo "$REPO" --workflow fork-desktop.yml --limit 20 \
        --json databaseId,headBranch -q "[.[] | select(.headBranch == \"$tag\")][0].databaseId // empty")"
      [ -z "$run_id" ] || break
      sleep 2
    done
    [ -n "$run_id" ] || die "no Fork Desktop run for $tag appeared within a minute — see https://github.com/$REPO/actions"
    # A red run fails this script, and fork/build.sh with it.
    gh run watch --repo "$REPO" --exit-status "$run_id"
    ;;
  status)
    gh release list --repo "$REPO" --limit 5
    ;;
  watch)
    gh run watch --repo "$REPO" \
      "$(gh run list --repo "$REPO" --workflow fork-desktop.yml --limit 1 --json databaseId -q '.[0].databaseId')"
    ;;
  *) die "unknown command: $cmd" ;;
esac
