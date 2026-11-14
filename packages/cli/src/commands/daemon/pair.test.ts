import { mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect } from "vitest";
import { resolveLocalPairingOffer } from "./pair.js";

test("offline pairing requires relay consent and saves it in the selected home", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-offline-pair-"));
  const home = path.join(root, "home");
  try {
    expect(await resolveLocalPairingOffer({ paseoHome: home })).toMatchObject({
      relayEnabled: false,
      url: null,
    });
    expect(existsSync(home)).toBe(false);
    const offer = await resolveLocalPairingOffer({ paseoHome: home, enableRelay: true });
    expect(offer.relayEnabled).toBe(true);
    expect(offer.url).toContain("offer=");
    expect(
      JSON.parse(await readFile(path.join(home, "config.json"), "utf8")).daemon.relay.enabled,
    ).toBe(true);
    expect(existsSync(path.join(home, "server-id"))).toBe(true);
    expect(existsSync(path.join(home, "daemon-keypair.json"))).toBe(true);
    expect(offer.expiresAt).toBeNull();
    expect(existsSync(path.join(home, "relay-devices.json"))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline pairing mints a one-time token when device authentication is on", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-offline-pair-auth-"));
  const home = path.join(root, "home");
  try {
    await mkdir(home, { recursive: true });
    await writeFile(
      path.join(home, "config.json"),
      JSON.stringify({ version: 1, daemon: { relay: { enabled: true, deviceAuth: true } } }),
    );

    const offer = await resolveLocalPairingOffer({ paseoHome: home });

    expect(offer.expiresAt).not.toBeNull();
    const invitations = JSON.parse(await readFile(path.join(home, "relay-devices.json"), "utf8"))
      .invitations as Array<{ expiresAt: string }>;
    expect(invitations.map((invitation) => invitation.expiresAt)).toEqual([offer.expiresAt]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
