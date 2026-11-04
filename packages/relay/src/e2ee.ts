export {
  openClientSecureChannel,
  openDaemonSecureChannel,
  PROTECTED_HANDSHAKE_FAILED_CLOSE_CODE,
  PROTECTED_MODE_REQUIRED_CLOSE_CODE,
  PROTECTED_MODE_REQUIRED_CLOSE_REASON,
  PROTECTED_RECORD_FAILED_CLOSE_CODE,
  SecureChannelRejectedError,
} from "./secure-channel.js";
export type {
  ClientSecureChannelOptions,
  DaemonSecureChannelOptions,
  SecureChannel,
  SecureChannelEvents,
  SecurityMode,
} from "./secure-channel.js";

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
