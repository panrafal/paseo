import AsyncStorage from "@react-native-async-storage/async-storage";
import type { TFunction } from "i18next";
import { z } from "zod";
import {
  parseRelayAuthFailure,
  type RelayAuthFailureReason,
  type RelayAuthOptions,
  type RelayAuthProof,
  type RelayDeviceCredential,
} from "@getpaseo/client/internal/daemon-client";
import type { ConnectionOffer } from "@getpaseo/protocol/connection-offer";

const RELAY_AUTH_STORAGE_KEY = "@paseo:relay-auth-v1";

const RelayAuthRecordSchema = z.object({
  daemonPublicKeyB64: z.string().min(1),
  credential: z.object({ id: z.string().min(1), secret: z.string().min(1) }).nullable(),
  /** Token from a pairing link that has not been exchanged yet. */
  pendingToken: z.string().min(1).nullable(),
  /** Last token imported, so reopening the same link does not replay a spent token. */
  lastImportedToken: z.string().min(1).nullable(),
});

const RelayAuthRecordsSchema = z.record(z.string(), RelayAuthRecordSchema);

type RelayAuthRecord = z.infer<typeof RelayAuthRecordSchema>;
type RelayAuthRecords = z.infer<typeof RelayAuthRecordsSchema>;

export interface RelayAuthStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export interface RelayHostKey {
  serverId: string;
  daemonPublicKeyB64: string;
}

export interface RelayAuthStore {
  importOffer(offer: ConnectionOffer): Promise<void>;
  resolveProof(host: RelayHostKey): Promise<RelayAuthProof | null>;
  saveCredential(host: RelayHostKey, credential: RelayDeviceCredential): Promise<void>;
  recordFailure(host: RelayHostKey, reason: RelayAuthFailureReason): Promise<void>;
}

function emptyRecord(daemonPublicKeyB64: string): RelayAuthRecord {
  return { daemonPublicKeyB64, credential: null, pendingToken: null, lastImportedToken: null };
}

/**
 * Relay pairing tokens and device credentials, kept apart from the host
 * registry so storing a credential never looks like a changed connection.
 * A record belongs to one daemon key; re-pairing with a new key starts over.
 */
export function createRelayAuthStore(storage: RelayAuthStorage): RelayAuthStore {
  let writes: Promise<void> = Promise.resolve();

  async function readRecords(): Promise<RelayAuthRecords> {
    const raw = await storage.getItem(RELAY_AUTH_STORAGE_KEY);
    if (!raw) return {};
    try {
      const parsed = RelayAuthRecordsSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : {};
    } catch {
      return {};
    }
  }

  async function readRecord(host: RelayHostKey): Promise<RelayAuthRecord> {
    const record = (await readRecords())[host.serverId];
    return record && record.daemonPublicKeyB64 === host.daemonPublicKeyB64
      ? record
      : emptyRecord(host.daemonPublicKeyB64);
  }

  function update(
    host: RelayHostKey,
    change: (record: RelayAuthRecord) => RelayAuthRecord,
  ): Promise<void> {
    const previous = writes;
    const next = (async () => {
      await previous;
      const records = await readRecords();
      const current = await readRecord(host);
      records[host.serverId] = change(current);
      await storage.setItem(RELAY_AUTH_STORAGE_KEY, JSON.stringify(records));
    })();
    writes = next.catch(() => undefined);
    return next;
  }

  return {
    importOffer(offer) {
      const token = offer.pairing?.token;
      if (!token) return Promise.resolve();
      return update(
        { serverId: offer.serverId, daemonPublicKeyB64: offer.daemonPublicKeyB64 },
        (record) =>
          record.lastImportedToken === token
            ? record
            : { ...record, pendingToken: token, lastImportedToken: token },
      );
    },
    async resolveProof(host) {
      await writes;
      const record = await readRecord(host);
      if (record.pendingToken) return { method: "token", token: record.pendingToken };
      if (record.credential) return { method: "credential", ...record.credential };
      return null;
    },
    saveCredential(host, credential) {
      return update(host, (record) => ({ ...record, credential, pendingToken: null }));
    },
    recordFailure(host, reason) {
      if (reason === "invalid_token") {
        return update(host, (record) => ({ ...record, pendingToken: null }));
      }
      if (reason === "invalid_credential" || reason === "password_changed") {
        return update(host, (record) => ({ ...record, credential: null }));
      }
      return Promise.resolve();
    },
  };
}

const defaultStore = createRelayAuthStore(AsyncStorage);

export function importRelayOffer(offer: ConnectionOffer): Promise<void> {
  return defaultStore.importOffer(offer);
}

export function createRelayAuthOptions(input: {
  host: RelayHostKey;
  label: string;
  store?: RelayAuthStore;
}): RelayAuthOptions {
  const { host, label } = input;
  const store = input.store ?? defaultStore;
  return {
    label,
    resolveProof: () => store.resolveProof(host),
    onCredentialIssued: (credential) => {
      void store.saveCredential(host, credential);
    },
    onAuthFailed: (reason) => {
      void store.recordFailure(host, reason);
    },
  };
}

const RELAY_AUTH_FAILURE_PATTERN = /relay_auth:([a-z_]+)/;

/** Replaces a relay authentication failure code in a connection error with readable copy. */
export function formatHostConnectionError(error: string, t: TFunction): string {
  const match = RELAY_AUTH_FAILURE_PATTERN.exec(error);
  const reason = match ? parseRelayAuthFailure(`relay_auth:${match[1]}`) : null;
  if (reason === null) return error;
  if (reason === "invalid_token") return t("pairing.relayAuth.linkUsed");
  if (reason === "password_changed") return t("pairing.relayAuth.passwordChanged");
  if (reason === "rate_limited") return t("pairing.relayAuth.rateLimited");
  return t("pairing.relayAuth.pairAgain");
}
