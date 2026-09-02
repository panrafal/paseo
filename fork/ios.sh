#!/usr/bin/env bash
#
# fork/ios.sh — build the fork's iOS app on EAS and ship it to TestFlight.
#
# The fork ships under its OWN bundle identifier, EAS project and App Store
# Connect record. Those live in fork/dist.env; nothing here is hardcoded.
#
# Commands:
#   fork/ios.sh build      EAS production build (waits for it)
#   fork/ios.sh submit     submit the latest build to TestFlight
#   fork/ios.sh ship       build then submit
#   fork/ios.sh doctor     check credentials and identifiers without building
#
# One-time setup, in the build checkout ($FORK_WORK_ROOT/build/packages/app):
#   npx eas login
#   npx eas init --id            # creates the fork's EAS project
#   npx eas credentials          # let EAS manage the iOS signing credentials
# then fill the FORK_* values into fork/dist.env.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=fork/config.sh
. "$HERE/config.sh"
set -a
# shellcheck source=fork/dist.env
. "$HERE/dist.env"
set +a

cmd="${1:-ship}"
APP_DIR="$BUILD_DIR/packages/app"

check_identifiers() {
  local missing=()
  for var in FORK_IOS_BUNDLE_ID FORK_EAS_OWNER FORK_EAS_PROJECT_ID FORK_ASC_APP_ID FORK_APPLE_TEAM_ID; do
    case "${!var}" in
      REPLACE_ME* | "") missing+=("$var") ;;
    esac
  done
  if [ ${#missing[@]} -gt 0 ]; then
    die "fill these in fork/dist.env on the $TOOLING_REF branch first:
$(printf '  %s\n' "${missing[@]}")"
  fi
  [ "$FORK_IOS_BUNDLE_ID" != "sh.paseo" ] ||
    die "FORK_IOS_BUNDLE_ID must differ from upstream's sh.paseo"
}

# The fork-dist branch makes app.config.js read these; eas.json is plain JSON
# with no interpolation, so the submit profile is rewritten in the disposable
# build checkout instead of being patched on a branch.
# The fork version is too short to be monotonic, but App Store Connect needs a
# CFBundleVersion that always increases. native-release-version.js reads this.
export PASEO_FORK_IOS_BUILD_NUMBER="$(fork_ios_build_number)"
export APP_PACKAGE_ID="$FORK_IOS_BUNDLE_ID"
export EAS_OWNER="$FORK_EAS_OWNER"
export EAS_PROJECT_ID="$FORK_EAS_PROJECT_ID"
export APPLE_TEAM_ID="$FORK_APPLE_TEAM_ID"

prepare_app_dir() {
  [ -d "$APP_DIR" ] || die "no build checkout at $BUILD_DIR — run fork/build.sh build first"
  node -e '
    const fs = require("node:fs");
    const p = process.argv[1];
    const eas = JSON.parse(fs.readFileSync(p, "utf8"));
    eas.submit ??= {};
    eas.submit.production ??= {};
    eas.submit.production.ios = {
      ...eas.submit.production.ios,
      ascAppId: process.env.FORK_ASC_APP_ID,
      appleTeamId: process.env.FORK_APPLE_TEAM_ID,
    };
    fs.writeFileSync(p, JSON.stringify(eas, null, 2) + "\n");
  ' "$APP_DIR/eas.json"
  say "eas.json in the build checkout points at ASC app $FORK_ASC_APP_ID"
}

case "$cmd" in
  doctor)
    check_identifiers
    say "Identifiers"
    printf '  bundle id      %s\n  eas owner      %s\n  eas project    %s\n  asc app id     %s\n  apple team     %s\n' \
      "$FORK_IOS_BUNDLE_ID" "$FORK_EAS_OWNER" "$FORK_EAS_PROJECT_ID" "$FORK_ASC_APP_ID" "$FORK_APPLE_TEAM_ID"
    [ -d "$APP_DIR" ] || die "no build checkout — run fork/build.sh build"
    (cd "$APP_DIR" && npx eas whoami)
    ;;
  build)
    check_identifiers
    prepare_app_dir
    say "EAS iOS production build"
    (cd "$APP_DIR" && npx eas build --platform ios --profile production --non-interactive --wait)
    ;;
  submit)
    check_identifiers
    prepare_app_dir
    say "Submitting the latest iOS build to TestFlight"
    (cd "$APP_DIR" && npx eas submit --platform ios --profile production --latest --non-interactive)
    ;;
  ship)
    "$0" build
    "$0" submit
    ;;
  *) die "unknown command: $cmd" ;;
esac
