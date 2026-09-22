export { createClientChannel, createDaemonChannel, EncryptedChannel } from "./encrypted-channel.js";
export type {
  Transport,
  TransportMessage,
  EncryptedChannelEvents,
  E2EECapabilities,
} from "./encrypted-channel.js";

export {
  RELAY_AUTH_CLOSE_CODE,
  RELAY_AUTH_FAILURE_REASONS,
  parseRelayAuthFrame,
  parseRelayAuthResultFrame,
} from "./relay-auth.js";
export type {
  RelayAuthFailureReason,
  RelayAuthFrame,
  RelayAuthProof,
  RelayAuthResultFrame,
  RelayDeviceCredential,
} from "./relay-auth.js";

export {
  generateKeyPair,
  exportPublicKey,
  importPublicKey,
  exportSecretKey,
  importSecretKey,
} from "./crypto.js";
export type { KeyPair, SharedKey } from "./crypto.js";
