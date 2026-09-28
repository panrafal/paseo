import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type pino from "pino";
import {
  createClientChannel,
  parseRelayAuthResultFrame,
  type Transport,
} from "@getpaseo/relay/e2ee";
import { exportPublicKey, generateKeyPair } from "@getpaseo/relay";
import { RelayAuthenticator, type RelayPasswordBinding } from "./relay-auth/authenticator";
import { RelayDeviceStore } from "./relay-auth/store";
import { startRelayTransport, type RelayAuthTiming } from "./relay-transport";

function createMockLogger() {
  const messages: { level: "debug" | "info" | "warn" | "error"; args: unknown[] }[] = [];
  const logger = {
    messages,
    child: () => logger,
    debug: (...args: unknown[]) => messages.push({ level: "debug", args }),
    info: (...args: unknown[]) => messages.push({ level: "info", args }),
    warn: (...args: unknown[]) => messages.push({ level: "warn", args }),
    error: (...args: unknown[]) => messages.push({ level: "error", args }),
  };
  return logger;
}

type TestLogger = ReturnType<typeof createMockLogger>;

function hasLogMessage(logger: TestLogger, level: "info" | "warn", message: string): boolean {
  return logger.messages.some((entry) => {
    return entry.level === level && entry.args.some((arg) => arg === message);
  });
}

class FakeRelayWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readyState = FakeRelayWebSocket.CONNECTING;
  sent: Array<string | Uint8Array | ArrayBuffer> = [];
  terminateCalls = 0;
  pingCalls = 0;
  deferSendCompletion = false;
  onSend: ((data: string | Uint8Array | ArrayBuffer) => void) | null = null;
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  private readonly pendingSendCallbacks: Array<(error?: Error) => void> = [];

  constructor(readonly url: string) {}

  on(event: string, listener: (...args: unknown[]) => void) {
    const handlers = this.listeners.get(event) ?? [];
    handlers.push(listener);
    this.listeners.set(event, handlers);
  }

  once(event: string, listener: (...args: unknown[]) => void) {
    const wrapped = (...args: unknown[]) => {
      this.off(event, wrapped);
      listener(...args);
    };
    this.on(event, wrapped);
  }

  close(code?: number, reason?: string) {
    this.readyState = FakeRelayWebSocket.CLOSED;
    this.emit("close", code ?? 1000, reason ?? "");
  }

  terminate() {
    this.terminateCalls += 1;
    this.readyState = FakeRelayWebSocket.CLOSED;
    this.emit("close", 1006, "");
  }

  send(data: string | Uint8Array | ArrayBuffer, callback?: (error?: Error) => void) {
    if (this.readyState !== FakeRelayWebSocket.OPEN) {
      throw new Error(`WebSocket not open (readyState=${this.readyState})`);
    }
    this.sent.push(data);
    this.onSend?.(data);
    if (!callback) return;
    if (this.deferSendCompletion) {
      this.pendingSendCallbacks.push(callback);
      return;
    }
    callback();
  }

  completeNextSend() {
    this.pendingSendCallbacks.shift()?.();
  }

  ping() {
    if (this.readyState !== FakeRelayWebSocket.OPEN) {
      throw new Error(`WebSocket not open (readyState=${this.readyState})`);
    }
    this.pingCalls += 1;
  }

  open() {
    this.readyState = FakeRelayWebSocket.OPEN;
    this.emit("open");
  }

  message(data: unknown, isBinary = data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    this.emit("message", data, isBinary);
  }

  pong() {
    this.emit("pong");
  }

  private off(event: string, listener: (...args: unknown[]) => void) {
    const handlers = this.listeners.get(event) ?? [];
    this.listeners.set(
      event,
      handlers.filter((handler) => handler !== listener),
    );
  }

  private emit(event: string, ...args: unknown[]) {
    const handlers = this.listeners.get(event) ?? [];
    for (const handler of handlers.slice()) {
      handler(...args);
    }
  }
}

function createFakeWebSockets() {
  const sockets: FakeRelayWebSocket[] = [];
  return {
    sockets,
    createWebSocket(url: string) {
      const socket = new FakeRelayWebSocket(url);
      sockets.push(socket);
      return socket;
    },
  };
}

describe("relay-transport control lifecycle", () => {
  const controllers: Array<{ stop: () => Promise<void> }> = [];
  let relay: ReturnType<typeof createFakeWebSockets>;

  beforeEach(() => {
    relay = createFakeWebSockets();
  });

  afterEach(async () => {
    await Promise.all(controllers.map((controller) => controller.stop()));
    controllers.length = 0;
    vi.useRealTimers();
  });

  test("logs relay_control_connected only after first valid control message", () => {
    const logger = createMockLogger();
    const controller = startRelayTransport({
      logger: logger as unknown as pino.Logger,
      attachSocket: async () => {},
      relayEndpoint: "relay.paseo.sh:443",
      relayUseTls: true,
      serverId: "srv_test",
      createWebSocket: relay.createWebSocket,
    });
    controllers.push(controller);

    const control = relay.sockets[0];
    expect(control).toBeDefined();

    control.open();
    expect(hasLogMessage(logger, "info", "relay_control_connected")).toBe(false);
    expect(control.pingCalls).toBeGreaterThan(0);

    control.message(JSON.stringify({ type: "sync", connectionIds: [] }));
    expect(hasLogMessage(logger, "info", "relay_control_connected")).toBe(true);
  });

  test("terminates and reconnects when control socket opens but never becomes ready", () => {
    vi.useFakeTimers();
    const logger = createMockLogger();
    const controller = startRelayTransport({
      logger: logger as unknown as pino.Logger,
      attachSocket: async () => {},
      relayEndpoint: "relay.paseo.sh:443",
      relayUseTls: true,
      serverId: "srv_test",
      createWebSocket: relay.createWebSocket,
    });
    controllers.push(controller);

    const firstControl = relay.sockets[0];
    firstControl.open();

    vi.advanceTimersByTime(8_000);
    expect(hasLogMessage(logger, "warn", "relay_control_ready_timeout_terminating")).toBe(true);
    expect(firstControl.terminateCalls).toBe(1);

    vi.advanceTimersByTime(1_000);
    expect(relay.sockets.length).toBeGreaterThanOrEqual(2);
  });

  test("terminates stale control sockets in under one minute", () => {
    vi.useFakeTimers();
    const logger = createMockLogger();
    const controller = startRelayTransport({
      logger: logger as unknown as pino.Logger,
      attachSocket: async () => {},
      relayEndpoint: "relay.paseo.sh:443",
      relayUseTls: true,
      serverId: "srv_test",
      createWebSocket: relay.createWebSocket,
    });
    controllers.push(controller);

    const control = relay.sockets[0];
    control.open();
    control.message(JSON.stringify({ type: "sync", connectionIds: [] }));
    logger.messages.length = 0;

    vi.advanceTimersByTime(40_000);
    expect(hasLogMessage(logger, "warn", "relay_control_stale_terminating")).toBe(true);
    expect(control.terminateCalls).toBe(1);
  });

  test("passes stable relay external session metadata when attaching data socket", async () => {
    const logger = createMockLogger();
    const attachedSockets: unknown[] = [];
    const attachedMetadata: unknown[] = [];
    const attachSocket = async (socket: unknown, metadata: unknown) => {
      attachedSockets.push(socket);
      attachedMetadata.push(metadata);
    };
    const controller = startRelayTransport({
      logger: logger as unknown as pino.Logger,
      attachSocket,
      relayEndpoint: "relay.paseo.sh:443",
      relayUseTls: true,
      serverId: "srv_test",
      createWebSocket: relay.createWebSocket,
    });
    controllers.push(controller);

    const control = relay.sockets[0];
    control.open();
    control.message(JSON.stringify({ type: "sync", connectionIds: [] }));
    control.message(JSON.stringify({ type: "connected", connectionId: "clt_test" }));

    const dataSocket = relay.sockets[1];
    expect(dataSocket).toBeDefined();
    dataSocket.open();

    await Promise.resolve();

    expect(attachedSockets).toEqual([dataSocket]);
    expect(attachedMetadata).toEqual([
      {
        transport: "relay",
        externalSessionKey: "session:clt_test",
        relayConnectionId: "clt_test",
      },
    ]);
  });

  test("encrypted sends wait for the physical data socket callback", async () => {
    const logger = createMockLogger();
    const daemonKeyPair = generateKeyPair();
    let resolveAttached: ((socket: unknown) => void) | undefined;
    const attached = new Promise<unknown>((resolve) => {
      resolveAttached = resolve;
    });
    const controller = startRelayTransport({
      logger: logger as unknown as pino.Logger,
      attachSocket: async (socket) => resolveAttached?.(socket),
      relayEndpoint: "relay.paseo.sh:443",
      relayUseTls: true,
      serverId: "srv_test",
      daemonKeyPair,
      createWebSocket: relay.createWebSocket,
    });
    controllers.push(controller);

    const control = relay.sockets[0];
    control.open();
    control.message(JSON.stringify({ type: "sync", connectionIds: [] }), false);
    control.message(JSON.stringify({ type: "connected", connectionId: "clt_test" }), false);

    const dataSocket = relay.sockets[1];
    dataSocket.deferSendCompletion = true;
    dataSocket.open();
    let clientTransport: Transport;
    clientTransport = {
      send: (data) => dataSocket.message(data, data instanceof ArrayBuffer),
      close: () => undefined,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    dataSocket.onSend = (data) => {
      clientTransport.onmessage?.({
        data: data instanceof Uint8Array ? data.slice().buffer : data,
        isBinary: data instanceof ArrayBuffer || data instanceof Uint8Array,
      });
    };
    let resolveClientOpen: (() => void) | undefined;
    const clientOpen = new Promise<void>((resolve) => {
      resolveClientOpen = resolve;
    });
    await createClientChannel(clientTransport, exportPublicKey(daemonKeyPair.publicKey), {
      onopen: () => resolveClientOpen?.(),
    });

    let attachedCompleted = false;
    void attached.then(() => {
      attachedCompleted = true;
      return undefined;
    });
    await clientOpen;
    await Promise.resolve();
    expect(attachedCompleted).toBe(false);
    dataSocket.completeNextSend();
    const encryptedSocket = (await attached) as {
      send: (data: Uint8Array) => void | Promise<void>;
    };
    let completed = false;

    const sending = Promise.resolve(encryptedSocket.send(new Uint8Array([1, 2, 3]))).then(() => {
      completed = true;
      return undefined;
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    dataSocket.completeNextSend();
    await sending;
    expect(completed).toBe(true);
  });

  test("uses relayUseTls for control and data socket URLs", () => {
    const logger = createMockLogger();
    const controller = startRelayTransport({
      logger: logger as unknown as pino.Logger,
      attachSocket: async () => {},
      relayEndpoint: "[::1]:443",
      relayUseTls: true,
      serverId: "srv_test",
      createWebSocket: relay.createWebSocket,
    });
    controllers.push(controller);

    const control = relay.sockets[0];
    control.open();
    control.message(JSON.stringify({ type: "sync", connectionIds: [] }));
    control.message(JSON.stringify({ type: "connected", connectionId: "clt_test" }));

    expect(relay.sockets[0]?.url).toMatch(/^wss:\/\/\[::1\]\/ws\?/);
    expect(relay.sockets[1]?.url).toMatch(/^wss:\/\/\[::1\]\/ws\?/);
  });
});

describe("relay-transport client authentication", () => {
  const controllers: Array<{ stop: () => Promise<void> }> = [];
  let relay: ReturnType<typeof createFakeWebSockets>;
  let home: string;
  let store: RelayDeviceStore;

  beforeEach(() => {
    relay = createFakeWebSockets();
    home = mkdtempSync(path.join(tmpdir(), "paseo-relay-transport-auth-"));
    store = new RelayDeviceStore({ paseoHome: home });
  });

  afterEach(async () => {
    await Promise.all(controllers.map((controller) => controller.stop()));
    controllers.length = 0;
    rmSync(home, { recursive: true, force: true });
  });

  async function connectClient(
    input: {
      authTiming?: RelayAuthTiming;
      password?: RelayPasswordBinding;
      deviceStore?: RelayDeviceStore;
    } = {},
  ) {
    const daemonKeyPair = generateKeyPair();
    const attached: unknown[] = [];
    const controller = startRelayTransport({
      logger: createMockLogger() as unknown as pino.Logger,
      attachSocket: async (socket) => {
        attached.push(socket);
      },
      relayEndpoint: "relay.paseo.sh:443",
      relayUseTls: true,
      serverId: "srv_test",
      daemonKeyPair,
      authenticator: new RelayAuthenticator({
        store: input.deviceStore ?? store,
        password: input.password ?? null,
      }),
      authTiming: input.authTiming,
      createWebSocket: relay.createWebSocket,
    });
    controllers.push(controller);

    const control = relay.sockets[0];
    control.open();
    control.message(JSON.stringify({ type: "sync", connectionIds: [] }), false);
    control.message(JSON.stringify({ type: "connected", connectionId: "clt_test" }), false);
    const dataSocket = relay.sockets[1];
    const closes: Array<{ code: unknown; reason: unknown }> = [];
    dataSocket.on("close", (code, reason) => closes.push({ code, reason }));
    dataSocket.open();

    const clientTransport: Transport = {
      send: (data) => dataSocket.message(data, data instanceof ArrayBuffer),
      close: () => undefined,
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    dataSocket.onSend = (data) => {
      clientTransport.onmessage?.({
        data: data instanceof Uint8Array ? data.slice().buffer : data,
        isBinary: data instanceof ArrayBuffer || data instanceof Uint8Array,
      });
    };
    const received: string[] = [];
    let resolveOpen: (() => void) | undefined;
    const opened = new Promise<void>((resolve) => {
      resolveOpen = resolve;
    });
    const channel = await createClientChannel(
      clientTransport,
      exportPublicKey(daemonKeyPair.publicKey),
      {
        onopen: () => resolveOpen?.(),
        onmessage: (data) => {
          if (typeof data === "string") received.push(data);
        },
      },
    );
    await opened;
    return { channel, attached, closes, received };
  }

  test("announces relayAuth to the client", async () => {
    const { channel } = await connectClient();

    expect(channel.peerCapabilities().relayAuth).toBe(true);
  });

  test("attaches a client that pairs with a one-time token and issues its credential", async () => {
    const { token } = store.createInvitation({ ttlMs: 60_000, now: new Date() });
    const { channel, attached, received } = await connectClient();

    await channel.send(JSON.stringify({ type: "relay_auth", v: 1, method: "token", token }));

    await vi.waitFor(() => expect(attached).toHaveLength(1));
    const [device] = store.listDevices();
    expect(received.map((frame) => parseRelayAuthResultFrame(frame))).toEqual([
      {
        type: "relay_auth_result",
        ok: true,
        credential: { id: device?.id, secret: expect.any(String) },
      },
    ]);
  });

  test("attaches a returning device that presents its credential", async () => {
    const { credential } = store.createDevice({
      label: "Phone",
      passwordFingerprint: null,
      now: new Date(),
    });
    const { channel, attached, received } = await connectClient();

    await channel.send(
      JSON.stringify({ type: "relay_auth", v: 1, method: "credential", ...credential }),
    );

    await vi.waitFor(() => expect(attached).toHaveLength(1));
    expect(received.map((frame) => parseRelayAuthResultFrame(frame))).toEqual([
      { type: "relay_auth_result", ok: true },
    ]);
  });

  test("rejects a credential issued before the password changed", async () => {
    const { credential } = store.createDevice({
      label: "Phone",
      passwordFingerprint: "bcrypt:old",
      now: new Date(),
    });
    const { channel, attached, closes, received } = await connectClient({
      password: { hash: "unused", fingerprint: "bcrypt:new" },
    });

    await channel.send(
      JSON.stringify({ type: "relay_auth", v: 1, method: "credential", ...credential }),
    );

    await vi.waitFor(() => expect(closes).toHaveLength(1));
    expect(received.map((frame) => parseRelayAuthResultFrame(frame))).toEqual([
      { type: "relay_auth_result", ok: false, reason: "password_changed" },
    ]);
    expect(closes[0]).toEqual({ code: 4401, reason: "password_changed" });
    expect(attached).toEqual([]);
  });

  test("closes a client whose first frame is application traffic", async () => {
    const { channel, attached, closes, received } = await connectClient();

    await channel.send(JSON.stringify({ type: "hello", clientId: "c", protocolVersion: 1 }));

    await vi.waitFor(() => expect(closes).toHaveLength(1));
    expect(closes[0]).toEqual({
      code: 4401,
      reason: "Pairing required. Update the app and pair this device again.",
    });
    expect(attached).toEqual([]);
    expect(received).toEqual([]);
  });

  test("closes a client that sends nothing before the authentication timeout", async () => {
    const { attached, closes } = await connectClient({
      authTiming: { timeoutMs: 20, revocationCheckMs: 60_000 },
    });

    await vi.waitFor(() => expect(closes).toHaveLength(1));
    expect(closes[0]).toEqual({
      code: 4401,
      reason: "Pairing required. Update the app and pair this device again.",
    });
    expect(attached).toEqual([]);
  });

  test("tells the client why authentication failed before closing", async () => {
    const { channel, attached, closes, received } = await connectClient();

    await channel.send(
      JSON.stringify({ type: "relay_auth", v: 1, method: "token", token: "not-a-token" }),
    );

    await vi.waitFor(() => expect(closes).toHaveLength(1));
    expect(received.map((frame) => parseRelayAuthResultFrame(frame))).toEqual([
      { type: "relay_auth_result", ok: false, reason: "invalid_token" },
    ]);
    expect(closes[0]).toEqual({ code: 4401, reason: "invalid_token" });
    expect(attached).toEqual([]);
  });

  test("does not read the device file while no session is open", async () => {
    class CountingDeviceStore extends RelayDeviceStore {
      listCalls = 0;
      override listDevices() {
        this.listCalls += 1;
        return super.listDevices();
      }
    }
    const deviceStore = new CountingDeviceStore({ paseoHome: home });
    await connectClient({ authTiming: { timeoutMs: 10_000, revocationCheckMs: 10 }, deviceStore });

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(deviceStore.listCalls).toBe(0);
  });

  test("closes open sessions instead of crashing when the device file can't be read", async () => {
    class UnreadableDeviceStore extends RelayDeviceStore {
      failReads = false;
      override listDevices() {
        if (this.failReads) throw new Error("EACCES: permission denied");
        return super.listDevices();
      }
    }
    const deviceStore = new UnreadableDeviceStore({ paseoHome: home });
    const { credential } = deviceStore.createDevice({
      label: "Phone",
      passwordFingerprint: null,
      now: new Date(),
    });
    const { channel, attached, closes } = await connectClient({
      authTiming: { timeoutMs: 10_000, revocationCheckMs: 20 },
      deviceStore,
    });
    await channel.send(
      JSON.stringify({ type: "relay_auth", v: 1, method: "credential", ...credential }),
    );
    await vi.waitFor(() => expect(attached).toHaveLength(1));

    deviceStore.failReads = true;

    await vi.waitFor(() => expect(closes).toHaveLength(1));
    expect(closes[0]).toEqual({ code: 4401, reason: "invalid_credential" });
  });

  test("closes an open session once its device is revoked", async () => {
    const { device, credential } = store.createDevice({
      label: "Phone",
      passwordFingerprint: null,
      now: new Date(),
    });
    const { channel, attached, closes } = await connectClient({
      authTiming: { timeoutMs: 10_000, revocationCheckMs: 20 },
    });
    await channel.send(
      JSON.stringify({ type: "relay_auth", v: 1, method: "credential", ...credential }),
    );
    await vi.waitFor(() => expect(attached).toHaveLength(1));

    store.revokeDevice(device.id);

    await vi.waitFor(() => expect(closes).toHaveLength(1));
    expect(closes[0]).toEqual({ code: 4401, reason: "invalid_credential" });
  });
});
