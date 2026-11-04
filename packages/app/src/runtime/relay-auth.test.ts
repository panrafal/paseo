import { beforeAll, describe, expect, it } from "vitest";
import { RelayAuthError } from "@getpaseo/client/internal/daemon-client";
import { i18n } from "@/i18n/i18next";
import type { ConnectionOffer } from "@getpaseo/protocol/connection-offer";
import {
  createRelayAuthStore,
  formatHostConnectionError,
  type RelayAuthStorage,
} from "./relay-auth";

function createMemoryStorage(): RelayAuthStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      values.set(key, value);
    },
  };
}

const HOST = { serverId: "srv_1", daemonPublicKeyB64: "pk_1" };

function offer(token: string, daemonPublicKeyB64 = "pk_1"): ConnectionOffer {
  return {
    v: 2,
    serverId: "srv_1",
    daemonPublicKeyB64,
    relay: { endpoint: "relay.paseo.sh:443", useTls: true },
    pairing: { token, expiresAt: "2026-09-13T10:05:00.000Z" },
  };
}

describe("relay auth store", () => {
  it("offers a new pairing token before an existing credential", async () => {
    const store = createRelayAuthStore(createMemoryStorage());
    await store.saveCredential(HOST, { id: "dev_1", secret: "secret-1" });
    await store.importOffer(offer("token-2"));

    expect(await store.resolveProof(HOST)).toEqual({ method: "token", token: "token-2" });
  });

  it("uses the issued credential once the token is exchanged", async () => {
    const store = createRelayAuthStore(createMemoryStorage());
    await store.importOffer(offer("token-1"));
    await store.saveCredential(HOST, { id: "dev_1", secret: "secret-1" });

    expect(await store.resolveProof(HOST)).toEqual({
      method: "credential",
      id: "dev_1",
      secret: "secret-1",
    });
  });

  it("does not replay a token when the same link is imported again", async () => {
    const store = createRelayAuthStore(createMemoryStorage());
    await store.importOffer(offer("token-1"));
    await store.saveCredential(HOST, { id: "dev_1", secret: "secret-1" });
    await store.importOffer(offer("token-1"));

    expect(await store.resolveProof(HOST)).toEqual({
      method: "credential",
      id: "dev_1",
      secret: "secret-1",
    });
  });

  it("drops a rejected token but keeps the credential", async () => {
    const store = createRelayAuthStore(createMemoryStorage());
    await store.saveCredential(HOST, { id: "dev_1", secret: "secret-1" });
    await store.importOffer(offer("token-2"));
    await store.recordFailure(HOST, "invalid_token");

    expect(await store.resolveProof(HOST)).toEqual({
      method: "credential",
      id: "dev_1",
      secret: "secret-1",
    });
  });

  it("forgets a credential the host no longer accepts", async () => {
    const store = createRelayAuthStore(createMemoryStorage());
    await store.saveCredential(HOST, { id: "dev_1", secret: "secret-1" });
    await store.recordFailure(HOST, "password_changed");

    expect(await store.resolveProof(HOST)).toBeNull();
  });

  it("ignores material stored for a different daemon key", async () => {
    const store = createRelayAuthStore(createMemoryStorage());
    await store.importOffer(offer("token-1", "pk_old"));

    expect(await store.resolveProof(HOST)).toBeNull();
  });
});

describe("formatHostConnectionError", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  it("translates the error a pairing probe rejects with", () => {
    expect(formatHostConnectionError(new RelayAuthError("invalid_token").message, i18n.t)).toBe(
      "This pairing link was already used or has expired. Create a new one on the host.",
    );
  });

  it("translates the close reason a host connection records", () => {
    expect(formatHostConnectionError("relay_auth:password_changed", i18n.t)).toBe(
      "The host password changed. Scan a new pairing code on the host.",
    );
  });

  it("leaves other connection errors alone", () => {
    expect(formatHostConnectionError("Transport closed (code 1006)", i18n.t)).toBe(
      "Transport closed (code 1006)",
    );
  });
});
