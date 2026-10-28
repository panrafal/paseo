/// <reference lib="dom" />
/**
 * Endpoint security boundary for relay-carried daemon sessions.
 *
 * A relay data socket arrives here as plaintext bytes. This module runs the
 * shared secure channel over it and hands the secured socket to session
 * admission, together with the negotiated security mode. Relay routing lives in
 * `relay-transport.ts`; credentials and authorization live in admission.
 */
import { EventEmitter } from "node:events";
import type pino from "pino";
import {
  openDaemonSecureChannel,
  parseRelayAuthFrame,
  RELAY_AUTH_CLOSE_CODE,
  SecureChannelRejectedError,
  type RelayAuthResultFrame,
  type KeyPair,
  type SecurityMode,
  type Transport as RelayTransport,
} from "@getpaseo/relay/e2ee";
import { createEncryptedRelaySocket, type EncryptedRelaySocket } from "./encrypted-relay-socket.js";
import type { RelayAuthenticator } from "../relay-auth/authenticator.js";

const HANDSHAKE_TIMEOUT_MS = 15_000;
const RELAY_AUTH_TIMEOUT_MS = 10_000;
const RELAY_AUTH_REVOCATION_CHECK_MS = 15_000;
const LEGACY_CLIENT_CLOSE_REASON = "Pairing required. Update the app and pair this device again.";

export interface RelayIngressSocket {
  readyState: number;
  bufferedAmount?: number;
  send: (data: string | Uint8Array | ArrayBuffer, callback?: (error?: Error) => void) => void;
  close: (code?: number, reason?: string) => void;
  terminate: () => void;
  on: (event: "message" | "close" | "error", listener: (...args: unknown[]) => void) => void;
}

export interface SecuredRelaySocket {
  socket: EncryptedRelaySocket;
  securityMode: SecurityMode;
}

export interface SecureRelayIngressOptions {
  daemonKeyPair: KeyPair;
  logger: pino.Logger;
  /**
   * Current policy, read when the peer's hello arrives so a flag flipped at
   * runtime applies to every admission from that moment on.
   */
  requireProtectedMode: () => boolean;
  authenticator?: RelayAuthenticator;
  authTimeoutMs?: number;
  revocationCheckMs?: number;
}

/**
 * Secures `socket` and admits it through `attach`. Messages the peer sends
 * before `attach` resolves are delivered once it has.
 *
 * A peer that never completes the handshake is terminated after
 * {@link HANDSHAKE_TIMEOUT_MS}; a failed handshake closes the socket.
 */
export async function admitSecuredRelaySocket(
  socket: RelayIngressSocket,
  options: SecureRelayIngressOptions,
  attach: (secured: SecuredRelaySocket) => Promise<void>,
): Promise<void> {
  const { logger } = options;
  const handshakeTimeout = setTimeout(() => {
    logger.warn("relay_e2ee_handshake_timeout_terminating");
    socket.terminate();
  }, HANDSHAKE_TIMEOUT_MS);
  try {
    const relayTransport = createRelayTransportAdapter(socket, logger);
    const emitter = new EventEmitter();
    const pendingMessages: Array<string | ArrayBuffer> = [];
    let attached = false;
    let awaitFirstMessage: ((data: string | ArrayBuffer | null) => void) | null = null;
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
    const channel = await openDaemonSecureChannel(relayTransport, {
      daemonKeyPair: options.daemonKeyPair,
      minimumMode: () => (options.requireProtectedMode() ? "protected" : "legacy"),
      relayAuth: options.authenticator !== undefined,
      events: {
        onmessage: emitMessage,
        onclose: (code, reason) => {
          if (awaitFirstMessage) {
            const deliver = awaitFirstMessage;
            awaitFirstMessage = null;
            deliver(null);
          }
          emitter.emit("close", code, reason);
        },
        onerror: (error) => {
          logger.warn({ err: error }, "relay_e2ee_error");
          emitter.emit("error", error);
        },
      },
    });
    clearTimeout(handshakeTimeout);
    let authenticatedDeviceId: string | null = null;
    if (options.authenticator) {
      const firstMessage =
        pendingMessages.shift() ??
        (await Promise.race([
          new Promise<string | ArrayBuffer | null>((resolve) => {
            awaitFirstMessage = resolve;
          }),
          delay(options.authTimeoutMs ?? RELAY_AUTH_TIMEOUT_MS, null),
        ]));
      awaitFirstMessage = null;
      const admission = await authenticateRelayClient({
        channel,
        authenticator: options.authenticator,
        firstMessage,
        logger,
      });
      if (!admission.admitted) return;
      authenticatedDeviceId = admission.deviceId;
    }
    const encryptedSocket = createEncryptedRelaySocket({
      channel,
      emitter,
      getTransportBufferedAmount: () => socket.bufferedAmount,
      terminateTransport: () => socket.terminate(),
    });
    await attach({ socket: encryptedSocket, securityMode: channel.securityMode() });
    attached = true;
    for (const message of pendingMessages) {
      emitter.emit("message", message);
    }
    pendingMessages.length = 0;
    if (authenticatedDeviceId) {
      let checking = false;
      const interval = setInterval(() => {
        if (checking) return;
        checking = true;
        void options
          .authenticator!.listActiveDeviceIds()
          .then((active) => {
            if (!active.has(authenticatedDeviceId!)) {
              logger.warn({ deviceId: authenticatedDeviceId }, "relay_auth_device_revoked_closing");
              channel.close(RELAY_AUTH_CLOSE_CODE, "invalid_credential");
            }
            return undefined;
          })
          .catch((error) => {
            logger.error({ err: error }, "relay_auth_device_check_failed_closing_sessions");
            channel.close(RELAY_AUTH_CLOSE_CODE, "invalid_credential");
          })
          .finally(() => {
            checking = false;
          });
      }, options.revocationCheckMs ?? RELAY_AUTH_REVOCATION_CHECK_MS);
      (interval as { unref?: () => void }).unref?.();
      const clearRevocationCheck = () => clearInterval(interval);
      channel.onClose(clearRevocationCheck);
      socket.on("close", clearRevocationCheck);
    }
  } catch (error) {
    if (error instanceof SecureChannelRejectedError) {
      logger.warn({ reason: error.message }, "relay_e2ee_handshake_rejected");
      try {
        socket.close(error.closeCode, error.closeReason);
      } catch {
        // ignore
      }
      return;
    }
    logger.warn({ err: error }, "relay_e2ee_handshake_failed");
    try {
      socket.close(1011, "E2EE handshake failed");
    } catch {
      // ignore
    }
  } finally {
    clearTimeout(handshakeTimeout);
  }
}

type RelayAdmission = { admitted: false } | { admitted: true; deviceId: string | null };

async function authenticateRelayClient(input: {
  channel: Awaited<ReturnType<typeof openDaemonSecureChannel>>;
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

function delay(ms: number, value: null): Promise<null> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms, value);
    (timer as { unref?: () => void }).unref?.();
  });
}

function createRelayTransportAdapter(
  socket: RelayIngressSocket,
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
