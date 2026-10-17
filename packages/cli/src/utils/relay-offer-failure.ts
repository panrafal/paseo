import {
  parseRelayAuthFailure,
  type RelayAuthFailureReason,
} from "@getpaseo/client/internal/daemon-client";

const SIGN_IN_HINT =
  "Run `paseo daemon pair` on the host for a new link, or set PASEO_PASSWORD to the daemon password.";

const FAILURE_MESSAGES: Record<RelayAuthFailureReason, string> = {
  credential_required: `The host requires device pairing. ${SIGN_IN_HINT}`,
  invalid_credential: `The host no longer accepts this device. ${SIGN_IN_HINT}`,
  password_changed: `The host password changed. ${SIGN_IN_HINT}`,
  invalid_token: `This pairing link was already used or has expired. ${SIGN_IN_HINT}`,
  invalid_password: "PASEO_PASSWORD doesn't match the daemon password.",
  password_not_configured:
    "The daemon has no password. Unset PASEO_PASSWORD and use a new pairing link from `paseo daemon pair`.",
  rate_limited: "Too many failed password attempts. Wait a minute, then try again.",
};

/** Turns a relay sign-in failure into what to do next, or null when the failure is something else. */
export function describeRelayOfferFailure(errors: Array<string | null>): string | null {
  for (const error of errors) {
    const reason = parseRelayAuthFailure(error);
    if (reason) return FAILURE_MESSAGES[reason];
  }
  return null;
}
