export type {
  DaemonTransport,
  DaemonTransportFactory,
  TransportLogger,
  WebSocketFactory,
  WebSocketLike,
} from "./daemon-client-transport-types.js";
export {
  decodeMessageData,
  describeTransportClose,
  describeTransportError,
  encodeUtf8String,
  extractRelayMessage,
  normalizeTransportPayload,
  safeRandomId,
} from "./daemon-client-transport-utils.js";
export {
  createEncryptedTransport,
  createRelayE2eeTransportFactory,
  parseRelayAuthFailure,
  RelayAuthError,
} from "./daemon-client-relay-e2ee-transport.js";
export type { RelayAuthOptions } from "./daemon-client-relay-e2ee-transport.js";
export {
  bindWsHandler,
  createWebSocketTransportFactory,
  defaultWebSocketFactory,
} from "./daemon-client-websocket-transport.js";
