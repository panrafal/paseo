#!/usr/bin/env bash
#
# fork/update-macos.sh — install a fork desktop build on a Mac.
#
#   fork/update-macos.sh                      the newest fork-v* release
#   fork/update-macos.sh fork-v0.7.2-panrafal.9   that one
#
# Run this ON THE LAPTOP. It needs only the gh CLI; it does not need a
# checkout of this repo — copy it over, or run it straight from GitHub:
#
#   gh api repos/panrafal/paseo/contents/fork/update-macos.sh?ref=main \
#     -H 'Accept: application/vnd.github.raw' | bash
#
# After the first install the app updates itself: the fork build's auto-update
# feed points at panrafal/paseo, not upstream.

set -euo pipefail

REPO="${FORK_REPO:-panrafal/paseo}"
APP="/Applications/Paseo.app"

die() {
  printf '\033[31merror:\033[0m %s\n' "$*" >&2
  exit 1
}
say() { printf '\033[1m==>\033[0m %s\n' "$*"; }

[ "$(uname -s)" = "Darwin" ] || die "run this on macOS"
command -v gh >/dev/null 2>&1 || die "the gh CLI is required: brew install gh"

arch="$(uname -m)" # arm64 or x86_64
case "$arch" in
  arm64) want=arm64 ;;
  x86_64) want=x64 ;;
  *) die "unsupported architecture: $arch" ;;
esac

tag="${1:-}"
case "$tag" in
  "") ;;
  fork-v*) ;;
  *) tag="fork-v$tag" ;;
esac
if [ -n "$tag" ]; then
  gh release view "$tag" --repo "$REPO" >/dev/null 2>&1 || die "no release $tag on $REPO"
else
  tag="$(gh release list --repo "$REPO" --limit 20 --json tagName,isDraft \
    -q '[.[] | select(.isDraft == false) | .tagName | select(startswith("fork-v"))][0]')"
  [ -n "$tag" ] && [ "$tag" != "null" ] || die "no fork-v* release found on $REPO"
fi

installed=""
[ -d "$APP" ] && installed="$(defaults read "$APP/Contents/Info" CFBundleShortVersionString 2>/dev/null || true)"
say "wanted: $tag   installed: ${installed:-none}"
if [ -n "$installed" ] && [ "$tag" = "fork-v$installed" ]; then
  say "Already up to date."
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
say "Downloading $tag ($want)"
gh release download "$tag" --repo "$REPO" --dir "$tmp" --pattern "*-${want}.dmg" --clobber
dmg="$(find "$tmp" -maxdepth 1 -name '*.dmg' | head -1)"
[ -n "$dmg" ] || die "no ${want} dmg in release $tag"

say "Mounting $(basename "$dmg")"
mount_point="$(hdiutil attach -nobrowse -readonly "$dmg" | awk -F'\t' '/\/Volumes\//{print $NF}' | tail -1)"
[ -n "$mount_point" ] || die "could not mount $dmg"
trap 'hdiutil detach "$mount_point" -quiet >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT

if pgrep -x Paseo >/dev/null 2>&1; then
  say "Quitting the running Paseo"
  osascript -e 'quit app "Paseo"' || true
  sleep 2
fi

say "Installing to $APP"
rm -rf "$APP"
cp -R "$mount_point/Paseo.app" /Applications/
# This fork signs but does not notarize the app. Clearing quarantine allows the
# signed build to launch without a Gatekeeper prompt.
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

say "Installed $(defaults read "$APP/Contents/Info" CFBundleShortVersionString)"
say "Launching"
open "$APP"
