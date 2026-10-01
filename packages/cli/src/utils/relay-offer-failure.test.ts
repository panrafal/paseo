import { describe, expect, test } from "vitest";
import { describeRelayOfferFailure } from "./relay-offer-failure.js";

describe("describeRelayOfferFailure", () => {
  test("says what to do when a pairing link is spent", () => {
    expect(
      describeRelayOfferFailure(["relay_auth:invalid_token", "relay_auth:invalid_token"]),
    ).toBe(
      "This pairing link was already used or has expired. Run `paseo daemon pair` on the host for a new link, or set PASEO_PASSWORD to the daemon password.",
    );
  });

  test("finds the reason in the client's last error", () => {
    expect(describeRelayOfferFailure(["Transport closed", "relay_auth:invalid_password"])).toBe(
      "PASEO_PASSWORD doesn't match the daemon password.",
    );
  });

  test("ignores failures that are not relay sign-in failures", () => {
    expect(describeRelayOfferFailure(["Connection timed out", null])).toBeNull();
  });
});
