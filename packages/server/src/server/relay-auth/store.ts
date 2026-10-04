import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type pino from "pino";
import { z } from "zod";
import type { RelayDeviceCredential } from "@getpaseo/relay/e2ee";

import { ensurePrivateFile, writePrivateFileAtomicSync } from "../private-files.js";

export const RELAY_DEVICES_FILENAME = "relay-devices.json";
export const MAX_RELAY_INVITATION_TTL_MS = 5 * 60_000;
const LAST_SEEN_WRITE_INTERVAL_MS = 60 * 60_000;

const RelayDeviceSchema = z.object({
  id: z.string().min(1),
  secretHash: z.string().min(1),
  label: z.string().nullable(),
  createdAt: z.string(),
  passwordFingerprint: z.string().nullable(),
  lastSeenAt: z.string().nullable().optional(),
});

const RelayInvitationRecordSchema = z.object({
  tokenHash: z.string().min(1),
  expiresAt: z.string(),
});

const RelayAuthFileSchema = z.object({
  v: z.literal(1),
  devices: z.array(RelayDeviceSchema),
  invitations: z.array(RelayInvitationRecordSchema),
});

type RelayAuthFile = z.infer<typeof RelayAuthFileSchema>;
export type RelayDevice = z.infer<typeof RelayDeviceSchema>;

export interface RelayInvitation {
  token: string;
  expiresAt: string;
}

export interface IssuedRelayDevice {
  device: RelayDevice;
  credential: RelayDeviceCredential;
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("base64url");
}

function hashesEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function emptyFile(): RelayAuthFile {
  return { v: 1, devices: [], invitations: [] };
}

/**
 * One-time pairing invitations and the device credentials they mint, persisted
 * in `$PASEO_HOME/relay-devices.json`. Only hashes of tokens and secrets are
 * stored. Every method reads the file first so edits made by an offline CLI
 * take effect on the next relay connection.
 */
export class RelayDeviceStore {
  private readonly filePath: string;
  private readonly logger: pino.Logger | undefined;

  constructor(options: { paseoHome: string; logger?: pino.Logger }) {
    this.filePath = path.join(options.paseoHome, RELAY_DEVICES_FILENAME);
    this.logger = options.logger?.child({ module: "relay-device-store" });
  }

  createInvitation(input: { ttlMs: number; now: Date }): RelayInvitation {
    if (input.ttlMs <= 0 || input.ttlMs > MAX_RELAY_INVITATION_TTL_MS) {
      throw new RangeError(
        `Pairing link lifetime must be between 1 ms and ${MAX_RELAY_INVITATION_TTL_MS} ms`,
      );
    }
    const token = randomBytes(24).toString("base64url");
    const expiresAt = new Date(input.now.getTime() + input.ttlMs).toISOString();
    const file = this.readWithoutExpired(input.now);
    file.invitations.push({ tokenHash: hashSecret(token), expiresAt });
    this.write(file);
    return { token, expiresAt };
  }

  /** Removes the invitation and reports whether it was valid. A token works once. */
  consumeInvitation(input: { token: string; now: Date }): boolean {
    const file = this.read();
    const live = file.invitations.filter(
      (invitation) => Date.parse(invitation.expiresAt) > input.now.getTime(),
    );
    const tokenHash = hashSecret(input.token);
    const remaining = live.filter((invitation) => !hashesEqual(invitation.tokenHash, tokenHash));
    // A wrong token with nothing to prune leaves the file untouched.
    if (remaining.length !== file.invitations.length) {
      this.write({ ...file, invitations: remaining });
    }
    return remaining.length !== live.length;
  }

  createDevice(input: {
    label: string | null;
    passwordFingerprint: string | null;
    now: Date;
  }): IssuedRelayDevice {
    const credential: RelayDeviceCredential = {
      id: `dev_${randomBytes(9).toString("base64url")}`,
      secret: randomBytes(32).toString("base64url"),
    };
    const device: RelayDevice = {
      id: credential.id,
      secretHash: hashSecret(credential.secret),
      label: input.label,
      createdAt: input.now.toISOString(),
      passwordFingerprint: input.passwordFingerprint,
      lastSeenAt: input.now.toISOString(),
    };
    const file = this.read();
    file.devices.push(device);
    this.write(file);
    return { device, credential };
  }

  findDeviceByCredential(credential: RelayDeviceCredential): RelayDevice | null {
    const device = this.read().devices.find((candidate) => candidate.id === credential.id);
    if (!device) return null;
    return hashesEqual(device.secretHash, hashSecret(credential.secret)) ? device : null;
  }

  findDevice(id: string): RelayDevice | null {
    return this.read().devices.find((device) => device.id === id) ?? null;
  }

  /** Records a sign-in, writing at most once an hour per device. */
  recordDeviceSeen(input: { id: string; now: Date }): void {
    const file = this.read();
    const device = file.devices.find((candidate) => candidate.id === input.id);
    if (!device) return;
    const lastSeen = device.lastSeenAt ? Date.parse(device.lastSeenAt) : 0;
    if (input.now.getTime() - lastSeen < LAST_SEEN_WRITE_INTERVAL_MS) return;
    const devices = file.devices.map((candidate) =>
      candidate.id === input.id ? { ...candidate, lastSeenAt: input.now.toISOString() } : candidate,
    );
    this.write({ ...file, devices });
  }

  listDevices(): RelayDevice[] {
    return this.read().devices;
  }

  revokeDevice(id: string): boolean {
    const file = this.read();
    const devices = file.devices.filter((device) => device.id !== id);
    if (devices.length === file.devices.length) return false;
    this.write({ ...file, devices });
    return true;
  }

  revokeAllDevices(): number {
    const file = this.read();
    this.write({ ...file, devices: [] });
    return file.devices.length;
  }

  private readWithoutExpired(now: Date): RelayAuthFile {
    const file = this.read();
    const invitations = file.invitations.filter(
      (invitation) => Date.parse(invitation.expiresAt) > now.getTime(),
    );
    return { ...file, invitations };
  }

  private read(): RelayAuthFile {
    if (!existsSync(this.filePath)) return emptyFile();
    ensurePrivateFile(this.filePath);
    const parsed = RelayAuthFileSchema.safeParse(
      safeJsonParse(readFileSync(this.filePath, "utf8")),
    );
    if (parsed.success) return parsed.data;
    // An unreadable file admits nobody; pairing again rewrites it.
    this.logger?.warn({ filePath: this.filePath }, "Ignoring unreadable relay device file");
    return emptyFile();
  }

  private write(file: RelayAuthFile): void {
    writePrivateFileAtomicSync(this.filePath, `${JSON.stringify(file, null, 2)}\n`);
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
