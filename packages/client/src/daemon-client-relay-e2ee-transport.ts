import {
  createClientChannel,
  parseRelayAuthResultFrame,
  RELAY_AUTH_CLOSE_CODE,
  RELAY_AUTH_FAILURE_REASONS,
  type EncryptedChannel,
  type RelayAuthFailureReason,
  type RelayAuthFrame,
  type RelayAuthProof,
  type RelayDeviceCredential,
  type Transport as RelayTransport,
} from "@getpaseo/relay/e2ee";
import type {
  DaemonTransport,
  DaemonTransportFactory,
  TransportLogger,
} from "./daemon-client-transport-types.js";
import { extractRelayMessage, normalizeTransportPayload } from "./daemon-client-transport-utils.js";

type OpenHandler = () => void;
type CloseHandler = (event?: unknown) => void;
type ErrorHandler = (event?: unknown) => void;
type MessageHandler = (data: unknown, isBinary: boolean) => void;

const RELAY_AUTH_RESULT_TIMEOUT_MS = 10_000;
const RELAY_AUTH_CLOSE_REASON_PREFIX = "relay_auth:";
const SKIP_CREDENTIAL = { issueCredential: false } as const;

export interface RelayAuthOptions {
  /**
   * What this client proves itself with, read at every handshake so a reconnect
   * uses a credential issued since the client was created. Null when it holds nothing.
   */
  resolveProof: () => Promise<RelayAuthProof | null>;
  /** Shown in the host's device list. */
  label?: string;
  /**
   * False signs in with a password without saving a device on the host. For clients
   * that keep no credential; a pairing token always issues one.
   */
  issueCredential?: boolean;
  onCredentialIssued?: (credential: RelayDeviceCredential) => void;
  onAuthFailed?: (reason: RelayAuthFailureReason) => void;
}

export class RelayAuthError extends Error {
  readonly reason: RelayAuthFailureReason;

  constructor(reason: RelayAuthFailureReason) {
    super(`${RELAY_AUTH_CLOSE_REASON_PREFIX}${reason}`);
    this.name = "RelayAuthError";
    this.reason = reason;
  }
}

/** Recovers the relay authentication failure from a client's last error, if that is what closed it. */
export function parseRelayAuthFailure(lastError: string | null): RelayAuthFailureReason | null {
  if (!lastError?.startsWith(RELAY_AUTH_CLOSE_REASON_PREFIX)) return null;
  const reason = lastError.slice(RELAY_AUTH_CLOSE_REASON_PREFIX.length);
  return RELAY_AUTH_FAILURE_REASONS.find((candidate) => candidate === reason) ?? null;
}

export function createRelayE2eeTransportFactory(args: {
  baseFactory: DaemonTransportFactory;
  daemonPublicKeyB64: string;
  logger: TransportLogger;
  auth?: RelayAuthOptions;
}): DaemonTransportFactory {
  return ({ url, headers }) => {
    const base = args.baseFactory({ url, headers });
    return createEncryptedTransport(base, args.daemonPublicKeyB64, args.logger, args.auth);
  };
}

export function createEncryptedTransport(
  base: DaemonTransport,
  daemonPublicKeyB64: string,
  logger: TransportLogger,
  auth?: RelayAuthOptions,
): DaemonTransport {
  let channel: EncryptedChannel | null = null;
  let opened = false;
  let closed = false;
  let awaitingAuthResult: ((text: string) => void) | null = null;

  const openHandlers = new Set<OpenHandler>();
  const closeHandlers = new Set<CloseHandler>();
  const errorHandlers = new Set<ErrorHandler>();
  const messageHandlers = new Set<MessageHandler>();

  const emitOpen = () => {
    if (opened || closed) {
      return;
    }
    opened = true;
    emitHandlers(openHandlers);
  };

  const emitClose = (event?: unknown) => {
    if (closed) {
      return;
    }
    closed = true;
    emitHandlers(closeHandlers, event);
  };

  const emitError = (event?: unknown) => {
    if (closed) {
      return;
    }
    emitHandlers(errorHandlers, event);
  };

  const emitMessage = (data: unknown) => {
    if (closed) {
      return;
    }
    if (awaitingAuthResult) {
      const deliver = awaitingAuthResult;
      awaitingAuthResult = null;
      deliver(typeof data === "string" ? data : "");
      return;
    }
    emitHandlers(messageHandlers, data, data instanceof ArrayBuffer);
  };

  const failAuth = (reason: RelayAuthFailureReason) => {
    logger.warn({ reason }, "relay_auth_failed");
    auth?.onAuthFailed?.(reason);
    emitError(new RelayAuthError(reason));
    const closeReason = `${RELAY_AUTH_CLOSE_REASON_PREFIX}${reason}`;
    base.close(RELAY_AUTH_CLOSE_CODE, closeReason);
    emitClose({ code: RELAY_AUTH_CLOSE_CODE, reason: closeReason });
  };

  const authenticate = async (openChannel: EncryptedChannel) => {
    if (openChannel.peerCapabilities().relayAuth !== true) {
      emitOpen();
      return;
    }
    const proof = auth ? await auth.resolveProof() : null;
    if (closed) return;
    if (!auth || !proof) {
      failAuth("credential_required");
      return;
    }
    const frame: RelayAuthFrame = {
      type: "relay_auth",
      v: 1,
      ...proof,
      ...(auth.label ? { label: auth.label } : {}),
      ...(auth.issueCredential === false ? SKIP_CREDENTIAL : {}),
    };
    const resultText = new Promise<string | null>((resolve) => {
      awaitingAuthResult = resolve;
    });
    await openChannel.send(JSON.stringify(frame));
    const text = await Promise.race([resultText, delay(RELAY_AUTH_RESULT_TIMEOUT_MS)]);
    awaitingAuthResult = null;
    if (closed) return;
    const result = text === null ? null : parseRelayAuthResultFrame(text);
    if (!result) {
      failAuth("credential_required");
      return;
    }
    if (!result.ok) {
      failAuth(result.reason);
      return;
    }
    if (result.credential) {
      auth.onCredentialIssued?.(result.credential);
    }
    emitOpen();
  };

  const relayTransport: RelayTransport = {
    send: (data) => {
      if (typeof data === "string") {
        base.send(data);
        return;
      }
      if (ArrayBuffer.isView(data)) {
        base.send(normalizeTransportPayload(data));
        return;
      }
      if (data instanceof ArrayBuffer) {
        base.send(data);
        return;
      }
      base.send(String(data));
    },
    close: (code?: number, reason?: string) => base.close(code, reason),
    onmessage: null,
    onclose: null,
    onerror: null,
  };

  const startHandshake = async () => {
    try {
      channel = await createClientChannel(relayTransport, daemonPublicKeyB64, {
        onopen: () => {
          if (!channel) return;
          void authenticate(channel).catch((error) => emitError(error));
        },
        onmessage: (data) => emitMessage(data),
        onclose: (code, reason) => emitClose({ code, reason }),
        onerror: (error) => emitError(error),
      });
    } catch (error) {
      logger.warn({ err: normalizeTransportError(error) }, "relay_e2ee_handshake_failed");
      emitError(error);
      // Browser WebSocket.close only accepts 1000 or 3000-4999.
      // Use an app-defined code so this path works in browser and Node runtimes.
      base.close(4001, "E2EE handshake failed");
    }
  };

  base.onOpen(() => {
    void startHandshake();
  });
  base.onMessage((data, isBinary) => {
    relayTransport.onmessage?.(extractRelayMessage(data, isBinary));
  });
  base.onClose((event) => {
    const record = event as { code?: number; reason?: string } | undefined;
    relayTransport.onclose?.(record?.code ?? 0, record?.reason ?? "");
    emitClose(event);
  });
  base.onError((event) => {
    relayTransport.onerror?.(event instanceof Error ? event : new Error(String(event)));
    emitError(event);
  });

  return {
    send: (data) => {
      if (!channel || !opened) {
        throw new Error("Encrypted channel not ready");
      }
      void channel.send(normalizeTransportPayload(data)).catch((error) => {
        emitError(error);
      });
    },
    close: (code?: number, reason?: string) => {
      if (channel) {
        channel.close(code, reason);
      } else {
        base.close(code, reason);
      }
      emitClose({ code, reason });
    },
    onMessage: (handler) => {
      messageHandlers.add(handler);
      return () => messageHandlers.delete(handler);
    },
    onOpen: (handler) => {
      openHandlers.add(handler);
      if (opened) {
        invokeHandler(handler);
      }
      return () => openHandlers.delete(handler);
    },
    onClose: (handler) => {
      closeHandlers.add(handler);
      if (closed) {
        invokeHandler(handler);
      }
      return () => closeHandlers.delete(handler);
    },
    onError: (handler) => {
      errorHandlers.add(handler);
      return () => errorHandlers.delete(handler);
    },
  };
}

function delay(ms: number): Promise<null> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms, null);
    (timer as { unref?: () => void }).unref?.();
  });
}

function emitHandlers<TArgs extends unknown[]>(
  handlers: Set<(...args: TArgs) => void>,
  ...args: TArgs
) {
  for (const handler of handlers) {
    invokeHandler(handler, ...args);
  }
}

function invokeHandler<TArgs extends unknown[]>(handler: (...args: TArgs) => void, ...args: TArgs) {
  try {
    handler(...args);
  } catch {
    // no-op
  }
}

function normalizeTransportError(error: unknown): Record<string, string> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(typeof error.stack === "string" ? { stack: error.stack } : {}),
    };
  }
  return { message: String(error) };
}
