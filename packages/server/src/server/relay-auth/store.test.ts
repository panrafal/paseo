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

  test("an invitation token works once", async () => {
    const invitation = await store.createInvitation({ ttlMs: 60_000, now: NOW });

    expect(invitation.expiresAt).toBe("2026-09-13T10:01:00.000Z");
    expect(await store.consumeInvitation({ token: invitation.token, now: NOW })).toBe(true);
    expect(await store.consumeInvitation({ token: invitation.token, now: NOW })).toBe(false);
  });

  test("an expired invitation is rejected and pruned", async () => {
    const invitation = await store.createInvitation({ ttlMs: 60_000, now: NOW });
    const later = new Date("2026-09-13T10:01:00.000Z");

    expect(await store.consumeInvitation({ token: invitation.token, now: later })).toBe(false);
    const file = JSON.parse(readFileSync(path.join(home, "relay-devices.json"), "utf8"));
    expect(file.invitations).toEqual([]);
  });

  test("the invitation lifetime is capped at five minutes", async () => {
    await expect(store.createInvitation({ ttlMs: 300_001, now: NOW })).rejects.toThrow(RangeError);
    await expect(store.createInvitation({ ttlMs: 0, now: NOW })).rejects.toThrow(RangeError);
    expect((await store.createInvitation({ ttlMs: 300_000, now: NOW })).expiresAt).toBe(
      "2026-09-13T10:05:00.000Z",
    );
  });

  test("stores only hashes of tokens and secrets, in a private file", async () => {
    const invitation = await store.createInvitation({ ttlMs: 60_000, now: NOW });
    const { credential } = await store.createDevice({
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

  test("finds a device only with its exact secret", async () => {
    const { credential } = await store.createDevice({
      label: "Phone",
      passwordFingerprint: "fp",
      now: NOW,
    });

    expect(await store.findDeviceByCredential(credential)).toEqual({
      id: credential.id,
      secretHash: expect.any(String),
      label: "Phone",
      createdAt: "2026-09-13T10:00:00.000Z",
      passwordFingerprint: "fp",
      lastSeenAt: "2026-09-13T10:00:00.000Z",
    });
    expect(await store.findDeviceByCredential({ id: credential.id, secret: "wrong" })).toBeNull();
    expect(
      await store.findDeviceByCredential({ id: "dev_missing", secret: credential.secret }),
    ).toBeNull();
  });

  test("records a sign-in at most once an hour", async () => {
    const { device } = await store.createDevice({
      label: "Phone",
      passwordFingerprint: null,
      now: NOW,
    });

    await store.recordDeviceSeen({ id: device.id, now: new Date("2026-09-13T10:30:00.000Z") });
    expect((await store.findDevice(device.id))?.lastSeenAt).toBe("2026-09-13T10:00:00.000Z");
    await store.recordDeviceSeen({ id: device.id, now: new Date("2026-09-13T11:00:00.000Z") });
    expect((await store.findDevice(device.id))?.lastSeenAt).toBe("2026-09-13T11:00:00.000Z");
  });

  test("a wrong token does not consume a valid one", async () => {
    const invitation = await store.createInvitation({ ttlMs: 60_000, now: NOW });

    expect(await store.consumeInvitation({ token: "wrong", now: NOW })).toBe(false);
    expect(await store.consumeInvitation({ token: invitation.token, now: NOW })).toBe(true);
  });

  test("serializes updates from separate stores for the same home", async () => {
    const otherStore = new RelayDeviceStore({ paseoHome: home });

    await Promise.all([
      store.createDevice({ label: "Phone", passwordFingerprint: null, now: NOW }),
      otherStore.createDevice({ label: "Tablet", passwordFingerprint: null, now: NOW }),
    ]);

    expect((await store.listDevices()).map((device) => device.label)).toEqual(["Phone", "Tablet"]);
  });

  test("revoking a device removes its credential", async () => {
    const first = await store.createDevice({ label: "Phone", passwordFingerprint: null, now: NOW });
    const second = await store.createDevice({
      label: "Tablet",
      passwordFingerprint: null,
      now: NOW,
    });

    expect(await store.revokeDevice(first.device.id)).toBe(true);
    expect(await store.revokeDevice(first.device.id)).toBe(false);
    expect(await store.findDeviceByCredential(first.credential)).toBeNull();
    expect((await store.listDevices()).map((device) => device.label)).toEqual(["Tablet"]);

    expect(await store.revokeAllDevices()).toBe(1);
    expect(await store.findDeviceByCredential(second.credential)).toBeNull();
  });

  test("an unreadable file admits no device", async () => {
    writeFileSync(path.join(home, "relay-devices.json"), "{not json");

    expect(await store.listDevices()).toEqual([]);
    expect(await store.findDeviceByCredential({ id: "dev_x", secret: "s" })).toBeNull();
  });
});
