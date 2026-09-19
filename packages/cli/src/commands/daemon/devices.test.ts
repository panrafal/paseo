import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { RelayDeviceStore } from "@getpaseo/server";
import { isRelayDeviceAuthEnabled, listRelayDevices, revokeRelayDevices } from "./devices.js";

const NOW = new Date("2026-09-13T10:00:00.000Z");

describe("daemon devices", () => {
  let home: string;
  let store: RelayDeviceStore;

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), "paseo-cli-devices-"));
    store = new RelayDeviceStore({ paseoHome: home });
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("lists paired devices without their secrets", () => {
    const phone = store.createDevice({ label: "Paseo app", passwordFingerprint: null, now: NOW });

    expect(listRelayDevices(home)).toEqual([
      {
        id: phone.device.id,
        label: "Paseo app",
        createdAt: "2026-09-13T10:00:00.000Z",
        lastSeenAt: "2026-09-13T10:00:00.000Z",
      },
    ]);
  });

  test("revokes one device by ID", () => {
    const phone = store.createDevice({ label: "Paseo app", passwordFingerprint: null, now: NOW });
    const cli = store.createDevice({ label: "Paseo CLI", passwordFingerprint: null, now: NOW });

    expect(
      revokeRelayDevices({ paseoHome: home, id: phone.device.id, all: false, deviceAuth: true }),
    ).toEqual({
      action: "revoked",
      revoked: 1,
      message: `Revoked ${phone.device.id}. It must pair again.`,
    });
    expect(store.findDeviceByCredential(phone.credential)).toBeNull();
    expect(listRelayDevices(home).map((row) => row.id)).toEqual([cli.device.id]);
  });

  test("revokes every device with --all", () => {
    store.createDevice({ label: "Paseo app", passwordFingerprint: null, now: NOW });
    store.createDevice({ label: "Paseo CLI", passwordFingerprint: null, now: NOW });

    expect(
      revokeRelayDevices({ paseoHome: home, id: undefined, all: true, deviceAuth: true }).revoked,
    ).toBe(2);
    expect(listRelayDevices(home)).toEqual([]);
  });

  test("warns that revoking has no effect while device authentication is off", () => {
    const phone = store.createDevice({ label: "Paseo app", passwordFingerprint: null, now: NOW });

    expect(
      revokeRelayDevices({ paseoHome: home, id: phone.device.id, all: false, deviceAuth: false })
        .message,
    ).toBe(
      `Revoked ${phone.device.id}. It must pair again. daemon.relay.deviceAuth is off, so relay clients still connect without pairing.`,
    );
    expect(isRelayDeviceAuthEnabled(home)).toBe(false);
  });

  test("rejects an unknown ID and ambiguous arguments", () => {
    expect(() =>
      revokeRelayDevices({ paseoHome: home, id: "dev_missing", all: false, deviceAuth: true }),
    ).toThrow(expect.objectContaining({ code: "DEVICE_NOT_FOUND" }));
    expect(() =>
      revokeRelayDevices({ paseoHome: home, id: undefined, all: false, deviceAuth: true }),
    ).toThrow(expect.objectContaining({ code: "DEVICE_REQUIRED" }));
    expect(() =>
      revokeRelayDevices({ paseoHome: home, id: "dev_x", all: true, deviceAuth: true }),
    ).toThrow(expect.objectContaining({ code: "INVALID_ARGUMENTS" }));
  });
});
