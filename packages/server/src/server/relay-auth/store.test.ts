import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { RelayDeviceStore } from "./store.js";

const NOW = new Date("2026-09-13T10:00:00.000Z");

describe("RelayDeviceStore", () => {
  let home: string;
  let store: RelayDeviceStore;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "paseo-relay-devices-"));
    store = new RelayDeviceStore({ paseoHome: home });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("an invitation token works once", () => {
    const invitation = store.createInvitation({ ttlMs: 60_000, now: NOW });

    expect(invitation.expiresAt).toBe("2026-09-13T10:01:00.000Z");
    expect(store.consumeInvitation({ token: invitation.token, now: NOW })).toBe(true);
    expect(store.consumeInvitation({ token: invitation.token, now: NOW })).toBe(false);
  });

  test("an expired invitation is rejected and pruned", () => {
    const invitation = store.createInvitation({ ttlMs: 60_000, now: NOW });
    const later = new Date("2026-09-13T10:01:00.000Z");

    expect(store.consumeInvitation({ token: invitation.token, now: later })).toBe(false);
    const file = JSON.parse(readFileSync(path.join(home, "relay-devices.json"), "utf8"));
    expect(file.invitations).toEqual([]);
  });

  test("the invitation lifetime is capped at five minutes", () => {
    expect(() => store.createInvitation({ ttlMs: 300_001, now: NOW })).toThrow(RangeError);
    expect(() => store.createInvitation({ ttlMs: 0, now: NOW })).toThrow(RangeError);
    expect(store.createInvitation({ ttlMs: 300_000, now: NOW }).expiresAt).toBe(
      "2026-09-13T10:05:00.000Z",
    );
  });

  test("stores only hashes of tokens and secrets, in a private file", () => {
    const invitation = store.createInvitation({ ttlMs: 60_000, now: NOW });
    const { credential } = store.createDevice({
      label: "Phone",
      passwordFingerprint: null,
      now: NOW,
    });

    const filePath = path.join(home, "relay-devices.json");
    const raw = readFileSync(filePath, "utf8");
    expect(raw).not.toContain(invitation.token);
    expect(raw).not.toContain(credential.secret);
    if (process.platform !== "win32") {
      expect(statSync(filePath).mode & 0o777).toBe(0o600);
    }
  });

  test("finds a device only with its exact secret", () => {
    const { credential } = store.createDevice({
      label: "Phone",
      passwordFingerprint: "fp",
      now: NOW,
    });

    expect(store.findDeviceByCredential(credential)).toEqual({
      id: credential.id,
      secretHash: expect.any(String),
      label: "Phone",
      createdAt: "2026-09-13T10:00:00.000Z",
      passwordFingerprint: "fp",
      lastSeenAt: "2026-09-13T10:00:00.000Z",
    });
    expect(store.findDeviceByCredential({ id: credential.id, secret: "wrong" })).toBeNull();
    expect(
      store.findDeviceByCredential({ id: "dev_missing", secret: credential.secret }),
    ).toBeNull();
  });

  test("records a sign-in at most once an hour", () => {
    const { device } = store.createDevice({ label: "Phone", passwordFingerprint: null, now: NOW });

    store.recordDeviceSeen({ id: device.id, now: new Date("2026-09-13T10:30:00.000Z") });
    expect(store.findDevice(device.id)?.lastSeenAt).toBe("2026-09-13T10:00:00.000Z");
    store.recordDeviceSeen({ id: device.id, now: new Date("2026-09-13T11:00:00.000Z") });
    expect(store.findDevice(device.id)?.lastSeenAt).toBe("2026-09-13T11:00:00.000Z");
  });

  test("a wrong token does not consume a valid one", () => {
    const invitation = store.createInvitation({ ttlMs: 60_000, now: NOW });

    expect(store.consumeInvitation({ token: "wrong", now: NOW })).toBe(false);
    expect(store.consumeInvitation({ token: invitation.token, now: NOW })).toBe(true);
  });

  test("revoking a device removes its credential", () => {
    const first = store.createDevice({ label: "Phone", passwordFingerprint: null, now: NOW });
    const second = store.createDevice({ label: "Tablet", passwordFingerprint: null, now: NOW });

    expect(store.revokeDevice(first.device.id)).toBe(true);
    expect(store.revokeDevice(first.device.id)).toBe(false);
    expect(store.findDeviceByCredential(first.credential)).toBeNull();
    expect(store.listDevices().map((device) => device.label)).toEqual(["Tablet"]);

    expect(store.revokeAllDevices()).toBe(1);
    expect(store.findDeviceByCredential(second.credential)).toBeNull();
  });

  test("an unreadable file admits no device", () => {
    writeFileSync(path.join(home, "relay-devices.json"), "{not json");

    expect(store.listDevices()).toEqual([]);
    expect(store.findDeviceByCredential({ id: "dev_x", secret: "s" })).toBeNull();
  });
});
