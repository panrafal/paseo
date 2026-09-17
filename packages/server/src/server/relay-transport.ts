/// <reference lib="dom" />
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import type pino from "pino";
import {
  createDaemonChannel,
  parseRelayAuthFrame,
  RELAY_AUTH_CLOSE_CODE,
  type EncryptedChannel,
  type KeyPair,
  type RelayAuthResultFrame,
  type Transport as RelayTransport,
} from "@getpaseo/relay/e2ee";
import { buildRelayWebSocketUrl } from "@getpaseo/protocol/daemon-endpoints";
import type { ExternalSocketMetadata } from "./websocket-server.js";
import { createEncryptedRelaySocket } from "./websocket/encrypted-relay-socket.js";
import type { RelayAuthenticator } from "./relay-auth/authenticator.js";

export interface RelayTransportOptions {
  logger: pino.Logger;
  attachSocket: (ws: RelaySocketLike, metadata?: ExternalSocketMetadata) => Promise<void>;
  relayEndpoint: string; // "host:port"
  relayUseTls: boolean;
  serverId: string;
  daemonKeyPair?: KeyPair;
  /** Requires each encrypted client to authenticate before its session attaches. */
  authenticator?: RelayAuthenticator;
  authTiming?: RelayAuthTiming;
  createWebSocket?: RelayWebSocketFactory;
}

export interface RelayTransportController {
  stop: () => Promise<void>;
}

export interface RelaySocketLike {
  readyState: number;
  bufferedAmount?: number;
  send: (data: string | Uint8Array | ArrayBuffer, callback?: (error?: Error) => void) => void;
  close: (code?: number, reason?: string) => void;
  terminate?: () => void;
  on: (event: "message" | "close" | "error", listener: (...args: unknown[]) => void) => void;
  once: (event: "close" | "error", listener: (...args: unknown[]) => void) => void;
}

interface RelayWebSocketLike extends RelaySocketLike {
  terminate: () => void;
  ping: () => void;
  on: (
    event: "open" | "message" | "close" | "error" | "pong",
    listener: (...args: unknown[]) => void,
  ) => void;
}

type RelayWebSocketFactory = (url: string) => RelayWebSocketLike;

type ControlMessage =
  | { type: "sync"; connectionIds: string[] }
  | { type: "connected"; connectionId: string }
  | { type: "disconnected"; connectionId: string }
  | { type: "ping" }
  | { type: "pong" };

const CONTROL_PING_INTERVAL_MS = 10_000;
const CONTROL_STALE_TIMEOUT_MS = 30_000;
const CONTROL_READY_TIMEOUT_MS = 8_000;
export interface RelayAuthTiming {
  /** How long a client has to send its relay_auth frame. */
  timeoutMs: number;
  /** How often open sessions are checked against revoked devices and password changes. */
  revocationCheckMs: number;
}

const DEFAULT_RELAY_AUTH_TIMING: RelayAuthTiming = { timeoutMs: 10_000, revocationCheckMs: 15_000 };
const LEGACY_CLIENT_CLOSE_REASON = "Pairing required. Update the app and pair this device again.";
const RELAY_WEBSOCKET_OPTIONS = { handshakeTimeout: 10_000, perMessageDeflate: false } as const;

function createDefaultRelayWebSocket(url: string): RelayWebSocketLike {
  return new WebSocket(url, RELAY_WEBSOCKET_OPTIONS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function tryParseControlMessage(raw: unknown): ControlMessage | null {
  try {
    let text: string;
    if (typeof raw === "string") {
      text = raw;
    } else if (Buffer.isBuffer(raw)) {
      text = raw.toString("utf8");
    } else {
      text = String(raw);
    }
    const parsed = JSON.parse(text);
    if (!isRecord(parsed)) return null;
    if (parsed.type === "ping") return { type: "ping" };
    if (parsed.type === "pong") return { type: "pong" };
    if (parsed.type === "sync" && Array.isArray(parsed.connectionIds)) {
      const connectionIds = parsed.connectionIds.filter(
        (id: unknown) => typeof id === "string" && id.trim().length > 0,
      );
      return { type: "sync", connectionIds };
    }
    if (
      parsed.type === "connected" &&
      typeof parsed.connectionId === "string" &&
      parsed.connectionId.trim()
    ) {
      return { type: "connected", connectionId: parsed.connectionId.trim() };
    }
    if (
      parsed.type === "disconnected" &&
      typeof parsed.connectionId === "string" &&
      parsed.connectionId.trim()
    ) {
      return { type: "disconnected", connectionId: parsed.connectionId.trim() };
    }
    return null;
  } catch {
    return null;
  }
}

export function startRelayTransport({
  logger,
  attachSocket,
  relayEndpoint,
  relayUseTls,
  serverId,
  daemonKeyPair,
  authenticator,
  authTiming = DEFAULT_RELAY_AUTH_TIMING,
  createWebSocket = createDefaultRelayWebSocket,
}: RelayTransportOptions): RelayTransportController {
  const relayLogger = logger.child({ module: "relay-transport" });

  let stopped = false;
  let controlWs: RelayWebSocketLike | null = null;
  let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  const dataSockets = new Map<string, RelayWebSocketLike>(); // connectionId -> ws
  let controlKeepaliveInterval: ReturnType<typeof setInterval> | null = null;
  let controlReadyTimeout: ReturnType<typeof setTimeout> | null = null;
  let controlLastSeenAt = 0;
  let controlConnectionSeq = 0;
  // The CLI revokes devices by editing the file, so open sessions are rechecked on a timer.
  const authenticatedDevices = new Map<RelayWebSocketLike, AuthenticatedDevice>();
  const revocationInterval = authenticator
    ? setInterval(() => closeRevokedSessions(authenticator), authTiming.revocationCheckMs)
    : null;

  // Runs on a timer outside any request, so a thrown read would crash the daemon.
  // An unreadable device file revokes every tracked session instead.
  const closeRevokedSessions = (activeAuthenticator: RelayAuthenticator): void => {
    if (authenticatedDevices.size === 0) return;
    let active: Set<string>;
    try {
      active = activeAuthenticator.listActiveDeviceIds();
    } catch (error) {
      relayLogger.error({ err: error }, "relay_auth_device_check_failed_closing_sessions");
      active = new Set();
    }
    for (const [socket, session] of authenticatedDevices) {
      if (active.has(session.deviceId)) continue;
      relayLogger.warn({ deviceId: session.deviceId }, "relay_auth_device_revoked_closing");
      authenticatedDevices.delete(socket);
      session.close();
    }
  };

  const stop = async (): Promise<void> => {
    stopped = true;
    if (revocationInterval) {
      clearInterval(revocationInterval);
    }
    authenticatedDevices.clear();
    if (reconnectTimeout) {
      clearTimeout(reconnectTimeout);
      reconnectTimeout = null;
    }
    if (controlKeepaliveInterval) {
      clearInterval(controlKeepaliveInterval);
      controlKeepaliveInterval = null;
    }
    if (controlReadyTimeout) {
      clearTimeout(controlReadyTimeout);
      controlReadyTimeout = null;
    }
    if (controlWs) {
      try {
        controlWs.close();
      } catch {
        // ignore
      }
      controlWs = null;
    }
    for (const ws of dataSockets.values()) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
    dataSockets.clear();
  };

  const connectControl = (): void => {
    if (stopped) return;

    const connectionId = ++controlConnectionSeq;
    const url = buildRelayWebSocketUrl({
      endpoint: relayEndpoint,
      useTls: relayUseTls,
      serverId,
      role: "server",
    });
    const socket = createWebSocket(url);
    controlWs = socket;
    let controlConnected = false;

    const markControlReady = () => {
      if (controlWs !== socket) return;
      if (controlConnected) return;
      controlConnected = true;
      reconnectAttempt = 0;
      if (controlReadyTimeout) {
        clearTimeout(controlReadyTimeout);
        controlReadyTimeout = null;
      }
      relayLogger.info({ connectionId }, "relay_control_connected");
    };

    socket.on("open", () => {
      if (controlWs !== socket) return;

      controlLastSeenAt = Date.now();
      if (controlKeepaliveInterval) {
        clearInterval(controlKeepaliveInterval);
        controlKeepaliveInterval = null;
      }
      if (controlReadyTimeout) {
        clearTimeout(controlReadyTimeout);
        controlReadyTimeout = null;
      }
      controlReadyTimeout = setTimeout(() => {
        if (stopped) return;
        if (controlWs !== socket) return;
        if (controlConnected) return;
        relayLogger.warn(
          { url, connectionId, waitedMs: CONTROL_READY_TIMEOUT_MS },
          "relay_control_ready_timeout_terminating",
        );
        try {
          socket.terminate();
        } catch {
          // ignore
        }
      }, CONTROL_READY_TIMEOUT_MS);
      controlKeepaliveInterval = setInterval(() => {
        if (stopped) return;
        if (controlWs !== socket) return;
        if (socket.readyState !== WebSocket.OPEN) return;

        const now = Date.now();
        const staleForMs = now - controlLastSeenAt;
        // If the control socket is half-open or silently dropped, ws may never emit "close".
        // Use a WebSocket protocol ping to detect staleness and force a reconnect.
        // Cloudflare's runtime auto-responds to protocol pings at the edge without waking the
        // hibernated relay Durable Object, so this keepalive does not incur DO CPU billing.
        if (staleForMs > CONTROL_STALE_TIMEOUT_MS) {
          relayLogger.warn(
            { url, staleForMs, connectionId, staleTimeoutMs: CONTROL_STALE_TIMEOUT_MS },
            "relay_control_stale_terminating",
          );
          try {
            socket.terminate();
          } catch {
            // ignore
          }
          return;
        }

        try {
          socket.ping();
        } catch (error) {
          relayLogger.warn({ err: error, connectionId }, "relay_control_ping_send_failed");
          try {
            socket.terminate();
          } catch {
            // ignore
          }
        }
      }, CONTROL_PING_INTERVAL_MS);
      try {
        socket.ping();
      } catch (error) {
        relayLogger.warn({ err: error, connectionId }, "relay_control_ping_send_failed");
        try {
          socket.terminate();
        } catch {
          // ignore
        }
      }
      relayLogger.debug({ connectionId }, "relay_control_open_waiting_for_ready");
    });

    socket.on("close", (code, reason) => {
      if (controlWs !== socket) return;
      relayLogger.warn(
        { code, reason: reason?.toString?.(), url, connectionId },
        "relay_control_disconnected",
      );
      controlWs = null;
      if (controlKeepaliveInterval) {
        clearInterval(controlKeepaliveInterval);
        controlKeepaliveInterval = null;
      }
      if (controlReadyTimeout) {
        clearTimeout(controlReadyTimeout);
        controlReadyTimeout = null;
      }
      scheduleReconnect();
    });

    socket.on("error", (err) => {
      if (controlWs !== socket) return;
      relayLogger.warn({ err, connectionId }, "relay_error");
      // close event will schedule reconnect
    });

    socket.on("pong", () => {
      if (controlWs !== socket) return;
      controlLastSeenAt = Date.now();
      relayLogger.debug({ connectionId }, "relay_control_pong_received");
    });

    socket.on("message", (data) => {
      if (controlWs !== socket) return;
      controlLastSeenAt = Date.now();
      const msg = tryParseControlMessage(data);
      if (msg) {
        markControlReady();
      }
      if (!msg) return;
      if (msg.type === "ping") {
        try {
          socket.send(JSON.stringify({ type: "pong", ts: Date.now() }));
        } catch {
          // ignore
        }
        return;
      }
      if (msg.type === "pong") return;
      if (msg.type === "sync") {
        for (const clientConnectionId of msg.connectionIds) {
          ensureClientDataSocket(clientConnectionId);
        }
        return;
      }
      if (msg.type === "connected") {
        ensureClientDataSocket(msg.connectionId);
        return;
      }
      if (msg.type === "disconnected") {
        const existing = dataSockets.get(msg.connectionId);
        if (existing) {
          try {
            existing.close(1001, "Client disconnected");
          } catch {
            // ignore
          }
          dataSockets.delete(msg.connectionId);
        }
      }
    });
  };

  const scheduleReconnect = (): void => {
    if (stopped) return;
    if (reconnectTimeout) return;

    reconnectAttempt += 1;
    const delayMs = Math.min(30000, 1000 * reconnectAttempt);
    reconnectTimeout = setTimeout(() => {
      reconnectTimeout = null;
      connectControl();
    }, delayMs);
  };

  const ensureClientDataSocket = (connectionId: string): void => {
    if (stopped) return;
    if (!connectionId) return;
    if (dataSockets.has(connectionId)) return;

    const url = buildRelayWebSocketUrl({
      endpoint: relayEndpoint,
      useTls: relayUseTls,
      serverId,
      role: "server",
      connectionId,
    });
    const socket = createWebSocket(url);
    dataSockets.set(connectionId, socket);

    let attached = false;
    const openTimeout = setTimeout(() => {
      if (stopped) return;
      if (socket.readyState === WebSocket.OPEN) return;
      relayLogger.warn({ connectionId }, "relay_data_open_timeout_terminating");
      try {
        socket.terminate();
      } catch {
        // ignore
      }
    }, 15_000);

    socket.on("open", () => {
      clearTimeout(openTimeout);
      relayLogger.info({ connectionId }, "relay_data_connected");
      if (attached) return;
      attached = true;
      const externalMetadata: ExternalSocketMetadata = {
        transport: "relay",
        externalSessionKey: `session:${connectionId}`,
        relayConnectionId: connectionId,
      };
      if (daemonKeyPair) {
        void attachEncryptedSocket({
          socket,
          daemonKeyPair,
          authenticator,
          authTimeoutMs: authTiming.timeoutMs,
          onDeviceAuthenticated: (deviceId, close) => {
            authenticatedDevices.set(socket, { deviceId, close });
          },
          logger: relayLogger.child({ connectionId }),
          attachSocket,
          metadata: externalMetadata,
        });
      } else {
        void attachSocket(socket, externalMetadata);
      }
    });

    socket.on("close", (code, reason) => {
      clearTimeout(openTimeout);
      relayLogger.warn(
        { code, reason: reason?.toString?.(), url, connectionId },
        "relay_data_disconnected",
      );
      authenticatedDevices.delete(socket);
      if (dataSockets.get(connectionId) === socket) {
        dataSockets.delete(connectionId);
      }
    });

    socket.on("error", (err) => {
      relayLogger.warn({ err, connectionId }, "relay_data_error");
    });
  };

  connectControl();

  return { stop };
}

interface AuthenticatedDevice {
  deviceId: string;
  close: () => void;
}

type RelayAdmission = { admitted: false } | { admitted: true; deviceId: string | null };

interface AttachEncryptedSocketInput {
  socket: RelayWebSocketLike;
  daemonKeyPair: KeyPair;
  authenticator: RelayAuthenticator | undefined;
  authTimeoutMs: number;
  onDeviceAuthenticated: (deviceId: string, close: () => void) => void;
  logger: pino.Logger;
  attachSocket: (ws: RelaySocketLike, metadata?: ExternalSocketMetadata) => Promise<void>;
  metadata: ExternalSocketMetadata;
}

async function attachEncryptedSocket({
  socket,
  daemonKeyPair,
  authenticator,
  authTimeoutMs,
  onDeviceAuthenticated,
  logger,
  attachSocket,
  metadata,
}: AttachEncryptedSocketInput): Promise<void> {
  try {
    const relayTransport = createRelayTransportAdapter(socket, logger);
    const emitter = new EventEmitter();
    const pendingMessages: Array<string | ArrayBuffer> = [];
    let attached = false;
    let awaitFirstMessage: ((data: string | ArrayBuffer) => void) | null = null;
    const emitMessage = (data: string | ArrayBuffer) => {
      if (attached) {
        emitter.emit("message", data);
        return;
      }
      if (awaitFirstMessage) {
        const deliver = awaitFirstMessage;
        awaitFirstMessage = null;
        deliver(data);
        return;
      }
      pendingMessages.push(data);
    };
    const channel = await createDaemonChannel(
      relayTransport,
      daemonKeyPair,
      {
        onmessage: emitMessage,
        onclose: (code, reason) => emitter.emit("close", code, reason),
        onerror: (error) => {
          logger.warn({ err: error }, "relay_e2ee_error");
          emitter.emit("error", error);
        },
      },
      { relayAuth: authenticator !== undefined },
    );
    if (authenticator) {
      const firstMessage =
        pendingMessages.shift() ??
        (await Promise.race([
          new Promise<string | ArrayBuffer>((resolve) => {
            awaitFirstMessage = resolve;
          }),
          delay(authTimeoutMs, null, { ref: false }),
        ]));
      awaitFirstMessage = null;
      const admission = await authenticateRelayClient({
        channel,
        authenticator,
        firstMessage,
        logger,
      });
      if (!admission.admitted) return;
      if (admission.deviceId) {
        onDeviceAuthenticated(admission.deviceId, () =>
          channel.close(RELAY_AUTH_CLOSE_CODE, "invalid_credential"),
        );
      }
    }
    const encryptedSocket = createEncryptedRelaySocket({
      channel,
      emitter,
      getTransportBufferedAmount: () => socket.bufferedAmount,
      terminateTransport: () => socket.terminate(),
    });
    await attachSocket(encryptedSocket, metadata);
    attached = true;
    for (const message of pendingMessages) {
      emitter.emit("message", message);
    }
    pendingMessages.length = 0;
  } catch (error) {
    logger.warn({ err: error }, "relay_e2ee_handshake_failed");
    try {
      socket.close(1011, "E2EE handshake failed");
    } catch {
      // ignore
    }
  }
}

async function authenticateRelayClient(input: {
  channel: EncryptedChannel;
  authenticator: RelayAuthenticator;
  firstMessage: string | ArrayBuffer | null;
  logger: pino.Logger;
}): Promise<RelayAdmission> {
  const { channel, logger } = input;
  const frame =
    typeof input.firstMessage === "string" ? parseRelayAuthFrame(input.firstMessage) : null;
  if (!frame) {
    logger.warn(
      { timedOut: input.firstMessage === null },
      "relay_auth_rejected_unauthenticated_client",
    );
    channel.close(RELAY_AUTH_CLOSE_CODE, LEGACY_CLIENT_CLOSE_REASON);
    return { admitted: false };
  }
  const outcome = await input.authenticator.authenticate(frame);
  const result: RelayAuthResultFrame = outcome.ok
    ? {
        type: "relay_auth_result",
        ok: true,
        ...(outcome.credential ? { credential: outcome.credential } : {}),
      }
    : { type: "relay_auth_result", ok: false, reason: outcome.reason };
  await channel.send(JSON.stringify(result));
  if (!outcome.ok) {
    logger.warn({ method: frame.method, reason: outcome.reason }, "relay_auth_rejected");
    channel.close(RELAY_AUTH_CLOSE_CODE, outcome.reason);
    return { admitted: false };
  }
  logger.info(
    { method: frame.method, deviceId: outcome.deviceId, issued: outcome.credential !== undefined },
    "relay_auth_accepted",
  );
  return { admitted: true, deviceId: outcome.deviceId };
}

function createRelayTransportAdapter(
  socket: RelayWebSocketLike,
  logger: pino.Logger,
): RelayTransport {
  const relayTransport: RelayTransport = {
    send: (data) =>
      new Promise<void>((resolve, reject) => {
        try {
          socket.send(data, (error) => {
            if (!error) {
              resolve();
              return;
            }
            logger.warn({ err: error }, "relay_socket_send_failed");
            reject(error);
          });
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          logger.warn({ err }, "relay_socket_send_failed");
          reject(err);
        }
      }),
    close: (code?: number, reason?: string) => socket.close(code, reason),
    onmessage: null,
    onclose: null,
    onerror: null,
  };

  socket.on("message", (data, isBinary) => {
    const binary = isBinary === true;
    relayTransport.onmessage?.({ data: normalizeMessageData(data, binary), isBinary: binary });
  });
  socket.on("close", (code, reason) => {
    const closeCode = typeof code === "number" ? code : 1006;
    relayTransport.onclose?.(closeCode, String(reason ?? ""));
  });
  socket.on("error", (err) => {
    relayTransport.onerror?.(err instanceof Error ? err : new Error(String(err)));
  });

  return relayTransport;
}

function normalizeMessageData(data: unknown, isBinary: boolean): string | ArrayBuffer {
  if (!isBinary) {
    if (typeof data === "string") return data;
    const buffer = bufferFromWsData(data);
    if (buffer) return buffer.toString("utf8");
    return String(data);
  }

  if (data instanceof ArrayBuffer) return data;

  const buffer = bufferFromWsData(data);
  if (buffer) {
    const view = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const out = new Uint8Array(view.byteLength);
    out.set(view);
    return out.buffer;
  }

  return String(data);
}

function bufferFromWsData(data: unknown): Buffer | null {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) {
    const buffers: Buffer[] = [];
    for (const part of data) {
      if (Buffer.isBuffer(part)) {
        buffers.push(part);
      } else if (part instanceof ArrayBuffer) {
        buffers.push(Buffer.from(part));
      } else if (ArrayBuffer.isView(part)) {
        buffers.push(Buffer.from(part.buffer, part.byteOffset, part.byteLength));
      } else if (typeof part === "string") {
        buffers.push(Buffer.from(part, "utf8"));
      } else {
        return null;
      }
    }
    return Buffer.concat(buffers);
  }
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}
