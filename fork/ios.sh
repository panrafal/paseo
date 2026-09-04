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
# EXPO_TOKEN is what lets `eas` run non-interactively. It comes from the
# encrypted fork/.env.fork; without one, `eas` falls back to the login in
# ~/.expo. `fork/ios.sh doctor` says which of the two you have.
#
# One-time setup, in the build checkout ($FORK_WORK_ROOT/build/packages/app):
#   npx eas login
#   npx eas init --id=<project id>   # link the EAS project made on expo.dev
#   npx eas credentials -p ios       # let EAS manage the iOS signing credentials
# then fill the FORK_* values into fork/dist.env. See fork/README.md.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=fork/config.sh
. "$HERE/config.sh"
set -a
# shellcheck source=fork/dist.env
. "$HERE/dist.env"
set +a

# Re-execs this script under dotenvx to put EXPO_TOKEN in the environment. An
# EXPO_TOKEN that is already exported wins and skips the whole thing.
[ -n "${EXPO_TOKEN:-}" ] || load_fork_secrets "$HERE/ios.sh" "$@"

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
export APP_PACKAGE_ID="$FORK_IOS_BUNDLE_ID"
export EAS_OWNER="$FORK_EAS_OWNER"
export EAS_PROJECT_ID="$FORK_EAS_PROJECT_ID"
export APPLE_TEAM_ID="$FORK_APPLE_TEAM_ID"

# `npx eas` is not safe here: under a pnpm-flavored npx it resolves against
# the registry and installs an unrelated package called `eas`, instead of the
# eas-cli the checkout pins. Use the checkout's own binary when it exists.
eas_cli() {
  if [ -x "$BUILD_DIR/node_modules/.bin/eas" ]; then
    "$BUILD_DIR/node_modules/.bin/eas" "$@"
  else
    npx eas "$@"
  fi
}

prepare_app_dir() {
  [ -d "$APP_DIR" ] || die "no build checkout at $BUILD_DIR — run fork/build.sh ios, which prepares one first"
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
    say "Expo credentials"
    if [ -z "${EXPO_TOKEN:-}" ]; then
      printf '  EXPO_TOKEN     not set — eas needs the interactive login in ~/.expo\n'
    elif [ -n "${FORK_SECRETS_LOADED:-}" ]; then
      printf '  EXPO_TOKEN     set, decrypted from %s\n' "$FORK_ENV_FILE"
    else
      printf '  EXPO_TOKEN     set, inherited from the environment\n'
    fi
    [ -d "$APP_DIR" ] || die "no build checkout at $BUILD_DIR — run fork/build.sh ios, which prepares one first"
    (cd "$APP_DIR" && eas_cli whoami) ||
      die "eas whoami failed, so nothing here can talk to Expo. Set a token:
  dotenvx set EXPO_TOKEN '<token>' -f fork/.env.fork
or log in once in $APP_DIR. See fork/README.md."
    ;;
  build)
    check_identifiers
    prepare_app_dir
    say "EAS iOS production build"
    (cd "$APP_DIR" && eas_cli build --platform ios --profile production --non-interactive --wait)
    ;;
  submit)
    check_identifiers
    prepare_app_dir
    say "Submitting the latest iOS build to TestFlight"
    (cd "$APP_DIR" && eas_cli submit --platform ios --profile production --latest --non-interactive)
    ;;
  ship)
    "$0" build
    "$0" submit
    ;;
  *) die "unknown command: $cmd" ;;
esac
