import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashSync } from "bcryptjs";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createRelayPasswordBinding, RelayAuthenticator } from "./authenticator.js";
import { RelayDeviceStore } from "./store.js";

const NOW = new Date("2026-09-13T10:00:00.000Z");

function hashPassword(password: string): string {
  return hashSync(password, 4);
}

describe("RelayAuthenticator", () => {
  let home: string;
  let store: RelayDeviceStore;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "paseo-relay-auth-"));
    store = new RelayDeviceStore({ paseoHome: home });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function authenticator(password: string | null) {
    const hash = password === null ? undefined : hashPassword(password);
    return new RelayAuthenticator({
      store,
      password: createRelayPasswordBinding({ hash, environmentPassword: undefined, salt: "pk" }),
      now: () => NOW,
    });
  }

  test("a pairing token mints a credential that authenticates later connections", async () => {
    const auth = authenticator(null);
    const { token } = store.createInvitation({ ttlMs: 60_000, now: NOW });

    const paired = await auth.authenticate({
      type: "relay_auth",
      v: 1,
      method: "token",
      token,
      label: "Phone",
    });
    if (!paired.ok || !paired.credential) throw new Error("expected an issued credential");

    expect(
      await auth.authenticate({
        type: "relay_auth",
        v: 1,
        method: "credential",
        ...paired.credential,
      }),
    ).toEqual({ ok: true, deviceId: paired.credential.id });
    expect(await auth.authenticate({ type: "relay_auth", v: 1, method: "token", token })).toEqual({
      ok: false,
      reason: "invalid_token",
    });
  });

  test("an unknown credential is rejected", async () => {
    expect(
      await authenticator(null).authenticate({
        type: "relay_auth",
        v: 1,
        method: "credential",
        id: "dev_missing",
        secret: "secret",
      }),
    ).toEqual({ ok: false, reason: "invalid_credential" });
  });

  test("the host password mints a credential", async () => {
    const auth = authenticator("hunter2");

    expect(
      await auth.authenticate({ type: "relay_auth", v: 1, method: "password", password: "nope" }),
    ).toEqual({ ok: false, reason: "invalid_password" });
    const paired = await auth.authenticate({
      type: "relay_auth",
      v: 1,
      method: "password",
      password: "hunter2",
    });
    expect(paired).toEqual({
      ok: true,
      deviceId: expect.stringMatching(/^dev_/),
      credential: { id: expect.stringMatching(/^dev_/), secret: expect.any(String) },
    });
  });

  test("password sign-in fails when the host has no password", async () => {
    expect(
      await authenticator(null).authenticate({
        type: "relay_auth",
        v: 1,
        method: "password",
        password: "hunter2",
      }),
    ).toEqual({ ok: false, reason: "password_not_configured" });
  });

  test("changing the password invalidates existing credentials", async () => {
    const before = await authenticator("first").authenticate({
      type: "relay_auth",
      v: 1,
      method: "password",
      password: "first",
    });
    if (!before.ok || !before.credential) throw new Error("expected an issued credential");

    expect(
      await authenticator("second").authenticate({
        type: "relay_auth",
        v: 1,
        method: "credential",
        ...before.credential,
      }),
    ).toEqual({ ok: false, reason: "password_changed" });
  });

  test("setting a password invalidates credentials minted without one", async () => {
    const { token } = store.createInvitation({ ttlMs: 60_000, now: NOW });
    const paired = await authenticator(null).authenticate({
      type: "relay_auth",
      v: 1,
      method: "token",
      token,
    });
    if (!paired.ok || !paired.credential) throw new Error("expected an issued credential");

    expect(
      await authenticator("new").authenticate({
        type: "relay_auth",
        v: 1,
        method: "credential",
        ...paired.credential,
      }),
    ).toEqual({ ok: false, reason: "password_changed" });
  });

  test("wrong tokens do not lock out a valid one", async () => {
    const auth = authenticator(null);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(
        await auth.authenticate({ type: "relay_auth", v: 1, method: "token", token: "guess" }),
      ).toEqual({ ok: false, reason: "invalid_token" });
    }
    const { token } = store.createInvitation({ ttlMs: 60_000, now: NOW });

    expect(await auth.authenticate({ type: "relay_auth", v: 1, method: "token", token })).toEqual({
      ok: true,
      deviceId: expect.stringMatching(/^dev_/),
      credential: { id: expect.stringMatching(/^dev_/), secret: expect.any(String) },
    });
  });

  test("repeated password failures are rate limited", async () => {
    const auth = authenticator("hunter2");
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(
        await auth.authenticate({ type: "relay_auth", v: 1, method: "password", password: "no" }),
      ).toEqual({ ok: false, reason: "invalid_password" });
    }

    expect(
      await auth.authenticate({
        type: "relay_auth",
        v: 1,
        method: "password",
        password: "hunter2",
      }),
    ).toEqual({ ok: false, reason: "rate_limited" });
  });

  test("password sign-in can skip saving a device", async () => {
    const auth = authenticator("hunter2");

    expect(
      await auth.authenticate({
        type: "relay_auth",
        v: 1,
        method: "password",
        password: "hunter2",
        issueCredential: false,
      }),
    ).toEqual({ ok: true, deviceId: null });
    expect(store.listDevices()).toEqual([]);
  });

  test("a credential sign-in records when the device was last seen", async () => {
    const auth = authenticator(null);
    const { credential } = store.createDevice({
      label: "Phone",
      passwordFingerprint: null,
      now: new Date("2026-09-13T08:00:00.000Z"),
    });

    await auth.authenticate({ type: "relay_auth", v: 1, method: "credential", ...credential });

    expect(store.findDevice(credential.id)?.lastSeenAt).toBe("2026-09-13T10:00:00.000Z");
  });

  test("a revoked device is no longer active", () => {
    const auth = authenticator(null);
    const { device } = store.createDevice({ label: "Phone", passwordFingerprint: null, now: NOW });

    expect(auth.listActiveDeviceIds()).toEqual(new Set([device.id]));
    store.revokeDevice(device.id);
    expect(auth.listActiveDeviceIds()).toEqual(new Set());
  });

  test("a device issued under another password is not active", () => {
    const { device } = store.createDevice({
      label: "Phone",
      passwordFingerprint: null,
      now: NOW,
    });

    expect(authenticator("hunter2").listActiveDeviceIds().has(device.id)).toBe(false);
  });
});

describe("createRelayPasswordBinding", () => {
  test("an environment password keeps its fingerprint across re-hashing", () => {
    const first = createRelayPasswordBinding({
      hash: hashPassword("hunter2"),
      environmentPassword: "hunter2",
      salt: "pk",
    });
    const second = createRelayPasswordBinding({
      hash: hashPassword("hunter2"),
      environmentPassword: "hunter2",
      salt: "pk",
    });

    expect(first?.fingerprint).toMatch(/^scrypt:/);
    expect(first?.fingerprint).toBe(second?.fingerprint);
  });

  test("a config password is fingerprinted by its stored hash", () => {
    const hash = hashPassword("hunter2");

    expect(
      createRelayPasswordBinding({ hash, environmentPassword: undefined, salt: "pk" })?.fingerprint,
    ).toMatch(/^bcrypt:/);
    expect(
      createRelayPasswordBinding({ hash: undefined, environmentPassword: "x", salt: "pk" }),
    ).toBeNull();
  });
});
