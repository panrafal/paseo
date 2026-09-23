import { describe, expect, it } from "vitest";
import { parseRelayAuthFrame, parseRelayAuthResultFrame } from "./relay-auth.js";

describe("relay auth frames", () => {
  it("parses each proof method", () => {
    expect(
      parseRelayAuthFrame(
        '{"type":"relay_auth","v":1,"method":"credential","id":"dev_1","secret":"s","label":"Phone"}',
      ),
    ).toEqual({
      type: "relay_auth",
      v: 1,
      method: "credential",
      id: "dev_1",
      secret: "s",
      label: "Phone",
    });
    expect(parseRelayAuthFrame('{"type":"relay_auth","v":1,"method":"token","token":"t"}')).toEqual(
      { type: "relay_auth", v: 1, method: "token", token: "t" },
    );
    expect(
      parseRelayAuthFrame('{"type":"relay_auth","v":1,"method":"password","password":"p"}'),
    ).toEqual({ type: "relay_auth", v: 1, method: "password", password: "p" });
  });

  it("keeps a request not to save a device", () => {
    expect(
      parseRelayAuthFrame(
        '{"type":"relay_auth","v":1,"method":"password","password":"p","issueCredential":false}',
      ),
    ).toEqual({
      type: "relay_auth",
      v: 1,
      method: "password",
      password: "p",
      issueCredential: false,
    });
  });

  it("rejects application traffic and incomplete proofs", () => {
    expect(parseRelayAuthFrame('{"type":"hello","clientId":"c"}')).toBeNull();
    expect(parseRelayAuthFrame('{"type":"relay_auth","v":1,"method":"token"}')).toBeNull();
    expect(
      parseRelayAuthFrame('{"type":"relay_auth","v":1,"method":"credential","id":"dev_1"}'),
    ).toBeNull();
    expect(parseRelayAuthFrame("not json")).toBeNull();
  });

  it("parses results with and without an issued credential", () => {
    expect(parseRelayAuthResultFrame('{"type":"relay_auth_result","ok":true}')).toEqual({
      type: "relay_auth_result",
      ok: true,
    });
    expect(
      parseRelayAuthResultFrame(
        '{"type":"relay_auth_result","ok":true,"credential":{"id":"dev_1","secret":"s"}}',
      ),
    ).toEqual({ type: "relay_auth_result", ok: true, credential: { id: "dev_1", secret: "s" } });
    expect(
      parseRelayAuthResultFrame('{"type":"relay_auth_result","ok":false,"reason":"invalid_token"}'),
    ).toEqual({ type: "relay_auth_result", ok: false, reason: "invalid_token" });
    expect(
      parseRelayAuthResultFrame('{"type":"relay_auth_result","ok":false,"reason":"other"}'),
    ).toBeNull();
  });
});
