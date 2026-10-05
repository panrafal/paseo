import { createHash, scryptSync } from "node:crypto";
import { compareSync } from "bcryptjs";
import type {
  RelayAuthFailureReason,
  RelayAuthFrame,
  RelayDeviceCredential,
} from "@getpaseo/relay/e2ee";

import { isBearerTokenValidAsync } from "../auth.js";
import type { RelayDeviceStore } from "./store.js";

const FAILURE_WINDOW_MS = 60_000;
const MAX_FAILURES_PER_WINDOW = 10;

export interface RelayPasswordBinding {
  /** bcrypt hash the daemon verifies passwords against. */
  hash: string;
  /** Stable across restarts while the password stays the same. */
  fingerprint: string;
}

export type RelayAuthOutcome =
  /** deviceId is null for a password sign-in that asked not to save a device. */
  | { ok: true; deviceId: string | null; credential?: RelayDeviceCredential }
  | { ok: false; reason: RelayAuthFailureReason };

/**
 * Derives the password fingerprint device credentials are bound to.
 *
 * `PASEO_PASSWORD` is re-hashed with a fresh salt at every start, so its bcrypt
 * hash cannot identify the password across restarts; the plaintext is stretched
 * with scrypt instead. A password from config.json keeps its stored hash.
 */
export function createRelayPasswordBinding(input: {
  hash: string | undefined;
  environmentPassword: string | undefined;
  salt: string;
}): RelayPasswordBinding | null {
  if (!input.hash) return null;
  const plaintext = input.environmentPassword?.trim();
  if (plaintext && compareSync(plaintext, input.hash)) {
    const stretched = scryptSync(plaintext, `paseo-relay-password:${input.salt}`, 32);
    return { hash: input.hash, fingerprint: `scrypt:${stretched.toString("base64url")}` };
  }
  const digest = createHash("sha256").update(input.hash).digest("base64url");
  return { hash: input.hash, fingerprint: `bcrypt:${digest}` };
}

export class RelayAuthenticator {
  private readonly store: RelayDeviceStore;
  private readonly password: RelayPasswordBinding | null;
  private readonly now: () => Date;
  private failures: number[] = [];

  constructor(options: {
    store: RelayDeviceStore;
    password: RelayPasswordBinding | null;
    now?: () => Date;
  }) {
    this.store = options.store;
    this.password = options.password;
    this.now = options.now ?? (() => new Date());
  }

  async authenticate(frame: RelayAuthFrame): Promise<RelayAuthOutcome> {
    const now = this.now();
    if (frame.method === "credential") {
      return this.authenticateCredential({ id: frame.id, secret: frame.secret, now });
    }
    if (frame.method === "token") {
      // Tokens are 192-bit random values, so guessing needs no throttle. Counting misses
      // would let anyone holding a spent link lock out every valid one.
      if (!this.store.consumeInvitation({ token: frame.token, now })) {
        return { ok: false, reason: "invalid_token" };
      }
      return this.issueDevice({ label: frame.label ?? null, now });
    }
    if (!this.password) return { ok: false, reason: "password_not_configured" };
    if (this.isRateLimited(now)) return { ok: false, reason: "rate_limited" };
    const valid = await isBearerTokenValidAsync({
      password: this.password.hash,
      token: frame.password,
    });
    if (!valid) return this.fail(now, "invalid_password");
    if (frame.issueCredential === false) return { ok: true, deviceId: null };
    return this.issueDevice({ label: frame.label ?? null, now });
  }

  /**
   * Devices whose sessions may stay open: not revoked, and issued under the current password.
   * Throws when the device file can't be read; callers treat that as revoking everyone.
   */
  listActiveDeviceIds(): Set<string> {
    const active = this.store
      .listDevices()
      .filter((device) => this.matchesPassword(device.passwordFingerprint))
      .map((device) => device.id);
    return new Set(active);
  }

  private authenticateCredential(input: {
    id: string;
    secret: string;
    now: Date;
  }): RelayAuthOutcome {
    const device = this.store.findDeviceByCredential({ id: input.id, secret: input.secret });
    if (!device) return { ok: false, reason: "invalid_credential" };
    if (!this.matchesPassword(device.passwordFingerprint)) {
      return { ok: false, reason: "password_changed" };
    }
    this.store.recordDeviceSeen({ id: device.id, now: input.now });
    return { ok: true, deviceId: device.id };
  }

  private matchesPassword(fingerprint: string | null): boolean {
    return fingerprint === (this.password?.fingerprint ?? null);
  }

  private issueDevice(input: { label: string | null; now: Date }): RelayAuthOutcome {
    const { device, credential } = this.store.createDevice({
      label: input.label,
      passwordFingerprint: this.password?.fingerprint ?? null,
      now: input.now,
    });
    return { ok: true, deviceId: device.id, credential };
  }

  private isRateLimited(now: Date): boolean {
    const windowStart = now.getTime() - FAILURE_WINDOW_MS;
    this.failures = this.failures.filter((timestamp) => timestamp > windowStart);
    return this.failures.length >= MAX_FAILURES_PER_WINDOW;
  }

  private fail(now: Date, reason: RelayAuthFailureReason): RelayAuthOutcome {
    this.failures.push(now.getTime());
    return { ok: false, reason };
  }
}
