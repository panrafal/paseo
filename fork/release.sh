#!/usr/bin/env bash
#
# fork/release.sh — build the desktop app on GitHub Actions instead of the Mac.
# fork/build.sh desktop --ci runs it; fork/build.sh desktop builds locally.
#
# Tags the current `main` commit as `fork-v<version>`, pushes it, and starts
# the fork's own Desktop workflow for that tag. The workflow builds and signs
# the macOS app on a macos runner, skips notarization, and publishes it to a
# GitHub Release on your fork, with an auto-update feed pointing at your fork
# rather than upstream. A tag already on that commit is reused, so a build
# that failed or never got a runner can be started again.
#
# Commands:
#   fork/release.sh desktop [<version>]   tag + push, start and watch the build
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

    tagged="$(git rev-parse -q --verify "refs/tags/$tag^{commit}" || true)"
    [ -z "$tagged" ] || [ "$tagged" = "$sha" ] ||
      die "tag $tag is on $(git rev-parse --short "$tagged"), not on $TARGET ($(git rev-parse --short "$sha"))"
    # main is derived by fork/integrate.sh and published from there. It is
    # pushed here only when it is ahead of the fork's copy — a run that was
    # not pushed — and never rewound: the fetch above refreshed the
    # remote-tracking ref, so a bare --force-with-lease would not stop that.
    if git rev-parse --verify -q "$FORK_REMOTE/$TARGET^{commit}" >/dev/null &&
      ! git merge-base --is-ancestor "$FORK_REMOTE/$TARGET" "$TARGET"; then
      die "$TARGET here ($(git rev-parse --short "$TARGET")) does not contain $FORK_REMOTE/$TARGET — it is behind or has diverged.
Reset it to the published one (git branch -f $TARGET $FORK_REMOTE/$TARGET, or reset the checkout that has it),
or publish yours with fork/integrate.sh first."
    fi
    git push -q "$FORK_REMOTE" "$TARGET:$TARGET"
    if [ -z "$tagged" ]; then
      git tag -a "$tag" "$sha" -m "Fork build $version from $TARGET"
      git push "$FORK_REMOTE" "$tag"
      say "Tagged $tag at $(git log -1 --format='%h %s' "$sha")"
    else
      say "Reusing $tag at $(git log -1 --format='%h %s' "$sha")"
    fi
    # The workflow no longer runs on tag pushes: fork/build.sh desktop and the
    # daemon deploy create the tag too, through the release, and neither wants
    # a second build on Actions.
    gh workflow run fork-desktop.yml --repo "$REPO" --ref "$TARGET" -f "tag=$tag"
    say "Waiting for the Desktop workflow: https://github.com/$REPO/actions"
    echo
    echo "When it finishes, update the Mac with:"
    echo "    fork/update-macos.sh          # run this on the laptop"
    echo "  or let the app's built-in updater find it — the feed now points at $REPO."
    # The run record shows up a few seconds after the dispatch. Asking for the
    # latest run right away returns the previous one, which "watch" reports
    # as finished at once — so find a queued or running one named for the tag
    # (the workflow's run-name), then wait for it.
    run_id=""
    for _ in $(seq 1 30); do
      run_id="$(gh run list --repo "$REPO" --workflow fork-desktop.yml --limit 20 \
        --json databaseId,displayTitle,status \
        -q "[.[] | select(.displayTitle == \"Fork Desktop $tag\" and .status != \"completed\")][0].databaseId // empty")"
      [ -z "$run_id" ] || break
      sleep 2
    done
    [ -n "$run_id" ] || die "no Fork Desktop run for $tag appeared within a minute — see https://github.com/$REPO/actions"
    run_url="https://github.com/$REPO/actions/runs/$run_id"
    say "Desktop build: $run_url"
    if [ -n "${FORK_BUILD_LINKS_FILE:-}" ]; then
      printf 'GitHub Actions: %s\n' "$run_url" >>"$FORK_BUILD_LINKS_FILE"
    fi
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
