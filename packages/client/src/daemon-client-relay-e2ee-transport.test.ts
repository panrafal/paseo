import { describe, expect, test, vi } from "vitest";
import {
  createDaemonChannel,
  exportPublicKey,
  generateKeyPair,
  parseRelayAuthFrame,
  type EncryptedChannel,
  type RelayAuthFrame,
  type RelayAuthResultFrame,
  type Transport,
} from "@getpaseo/relay/e2ee";
import type { DaemonTransport } from "./daemon-client-transport-types.js";
import {
  createEncryptedTransport,
  parseRelayAuthFailure,
  type RelayAuthOptions,
} from "./daemon-client-relay-e2ee-transport.js";

interface Harness {
  events: string[];
  frames: RelayAuthFrame[];
  closes: Array<{ code?: number; reason?: string }>;
  errors: unknown[];
  daemon: Promise<EncryptedChannel>;
  client: DaemonTransport;
}

function connect(input: {
  relayAuth: boolean;
  auth?: RelayAuthOptions;
  respond?: (frame: RelayAuthFrame) => RelayAuthResultFrame;
}): Harness {
  const events: string[] = [];
  const frames: RelayAuthFrame[] = [];
  const closes: Array<{ code?: number; reason?: string }> = [];
  const errors: unknown[] = [];
  const clientHandlers: {
    open: Array<() => void>;
    message: Array<(data: unknown, isBinary: boolean) => void>;
  } = { open: [], message: [] };

  const daemonTransport: Transport = {
    send: (data) => {
      setTimeout(() => {
        for (const handler of clientHandlers.message) handler(data, data instanceof ArrayBuffer);
      }, 0);
    },
    close: () => undefined,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  const base: DaemonTransport = {
    send: (data) => {
      setTimeout(() => {
        daemonTransport.onmessage?.({
          data: data as string | ArrayBuffer,
          isBinary: data instanceof ArrayBuffer,
        });
      }, 0);
    },
    close: (code, reason) => closes.push({ code, reason }),
    onOpen: (handler) => {
      clientHandlers.open.push(handler);
      return () => undefined;
    },
    onClose: () => () => undefined,
    onError: () => () => undefined,
    onMessage: (handler) => {
      clientHandlers.message.push(handler);
      return () => undefined;
    },
  };

  const daemonKeyPair = generateKeyPair();
  let daemonChannel: EncryptedChannel | null = null;
  const daemon = createDaemonChannel(
    daemonTransport,
    daemonKeyPair,
    {
      onmessage: (data) => {
        if (typeof data !== "string") return;
        const frame = parseRelayAuthFrame(data);
        if (frame) {
          frames.push(frame);
          if (input.respond && daemonChannel) {
            void daemonChannel.send(JSON.stringify(input.respond(frame)));
          }
          return;
        }
        events.push(`daemon received ${data}`);
      },
    },
    { relayAuth: input.relayAuth },
  ).then((channel) => {
    daemonChannel = channel;
    return channel;
  });

  const client = createEncryptedTransport(
    base,
    exportPublicKey(daemonKeyPair.publicKey),
    { warn: () => undefined },
    input.auth,
  );
  client.onOpen(() => events.push("open"));
  client.onError((error) => errors.push(error));
  for (const handler of clientHandlers.open) handler();
  return { events, frames, closes, errors, daemon, client };
}

describe("relay E2EE transport authentication", () => {
  test("opens without authenticating when the daemon does not ask for it", async () => {
    const harness = connect({ relayAuth: false });

    await vi.waitFor(() => expect(harness.events).toEqual(["open"]));
    expect(harness.frames).toEqual([]);
  });

  test("exchanges a pairing token for a credential before opening", async () => {
    const issued: unknown[] = [];
    const harness = connect({
      relayAuth: true,
      auth: {
        resolveProof: async () => ({ method: "token", token: "token-abc" }),
        label: "Phone",
        onCredentialIssued: (credential) => issued.push(credential),
      },
      respond: () => ({
        type: "relay_auth_result",
        ok: true,
        credential: { id: "dev_1", secret: "secret-1" },
      }),
    });

    await vi.waitFor(() => expect(harness.events).toEqual(["open"]));
    expect(harness.frames).toEqual([
      { type: "relay_auth", v: 1, method: "token", token: "token-abc", label: "Phone" },
    ]);
    expect(issued).toEqual([{ id: "dev_1", secret: "secret-1" }]);

    harness.client.send('{"type":"hello"}');
    await vi.waitFor(() =>
      expect(harness.events).toEqual(["open", 'daemon received {"type":"hello"}']),
    );
  });

  test("closes with the daemon's reason when authentication fails", async () => {
    const failures: string[] = [];
    const harness = connect({
      relayAuth: true,
      auth: {
        resolveProof: async () => ({ method: "credential", id: "dev_1", secret: "stale" }),
        onAuthFailed: (reason) => failures.push(reason),
      },
      respond: () => ({ type: "relay_auth_result", ok: false, reason: "password_changed" }),
    });

    await vi.waitFor(() =>
      expect(harness.closes).toEqual([{ code: 4401, reason: "relay_auth:password_changed" }]),
    );
    expect(harness.events).toEqual([]);
    expect(failures).toEqual(["password_changed"]);
    expect(harness.errors.map(String)).toEqual(["RelayAuthError: relay_auth:password_changed"]);
    expect(parseRelayAuthFailure("relay_auth:password_changed")).toBe("password_changed");
  });

  test("fails without contacting the daemon when the client holds no proof", async () => {
    const harness = connect({ relayAuth: true, auth: { resolveProof: async () => null } });

    await vi.waitFor(() =>
      expect(harness.closes).toEqual([{ code: 4401, reason: "relay_auth:credential_required" }]),
    );
    expect(harness.frames).toEqual([]);
    expect(harness.events).toEqual([]);
  });
});

test("asks the daemon not to save a device when the client keeps no credential", async () => {
  const harness = connect({
    relayAuth: true,
    auth: {
      resolveProof: async () => ({ method: "password", password: "hunter2" }),
      issueCredential: false,
    },
    respond: () => ({ type: "relay_auth_result", ok: true }),
  });

  await vi.waitFor(() => expect(harness.events).toEqual(["open"]));
  expect(harness.frames).toEqual([
    { type: "relay_auth", v: 1, method: "password", password: "hunter2", issueCredential: false },
  ]);
});

describe("parseRelayAuthFailure", () => {
  test("ignores unrelated errors and unknown reasons", () => {
    expect(parseRelayAuthFailure("Transport closed (code 1006)")).toBeNull();
    expect(parseRelayAuthFailure("relay_auth:unknown")).toBeNull();
    expect(parseRelayAuthFailure(null)).toBeNull();
  });
});
