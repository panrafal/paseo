/**
 * Client authentication frames exchanged inside the E2EE channel.
 *
 * The daemon public key only authenticates the daemon. A daemon that announces
 * the `relayAuth` capability expects the client's first encrypted frame to be a
 * `relay_auth` frame, and attaches no session until it answers `ok: true`.
 */

export const RELAY_AUTH_CLOSE_CODE = 4401;

export interface RelayDeviceCredential {
  id: string;
  secret: string;
}

export type RelayAuthProof =
  | { method: "credential"; id: string; secret: string }
  | { method: "token"; token: string }
  | { method: "password"; password: string };

export type RelayAuthFrame = RelayAuthProof & {
  type: "relay_auth";
  v: 1;
  label?: string;
  /** False asks the daemon not to save a device. Honored only for password sign-in. */
  issueCredential?: false;
};

export const RELAY_AUTH_FAILURE_REASONS = [
  "credential_required",
  "invalid_credential",
  "password_changed",
  "invalid_token",
  "invalid_password",
  "password_not_configured",
  "rate_limited",
] as const;

export type RelayAuthFailureReason = (typeof RELAY_AUTH_FAILURE_REASONS)[number];

export type RelayAuthResultFrame =
  | { type: "relay_auth_result"; ok: true; credential?: RelayDeviceCredential }
  | { type: "relay_auth_result"; ok: false; reason: RelayAuthFailureReason };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseProof(record: Record<string, unknown>): RelayAuthProof | null {
  if (record.method === "credential" && isNonEmptyString(record.id)) {
    return isNonEmptyString(record.secret)
      ? { method: "credential", id: record.id, secret: record.secret }
      : null;
  }
  if (record.method === "token" && isNonEmptyString(record.token)) {
    return { method: "token", token: record.token };
  }
  if (record.method === "password" && isNonEmptyString(record.password)) {
    return { method: "password", password: record.password };
  }
  return null;
}

export function parseRelayAuthFrame(text: string): RelayAuthFrame | null {
  const record = parseJsonRecord(text);
  if (!record || record.type !== "relay_auth" || record.v !== 1) return null;
  const proof = parseProof(record);
  if (!proof) return null;
  const label = typeof record.label === "string" ? record.label.slice(0, 120) : undefined;
  return {
    type: "relay_auth",
    v: 1,
    ...proof,
    ...(label ? { label } : {}),
    ...(record.issueCredential === false ? { issueCredential: false as const } : {}),
  };
}

function isFailureReason(value: unknown): value is RelayAuthFailureReason {
  return RELAY_AUTH_FAILURE_REASONS.some((reason) => reason === value);
}

export function parseRelayAuthResultFrame(text: string): RelayAuthResultFrame | null {
  const record = parseJsonRecord(text);
  if (!record || record.type !== "relay_auth_result") return null;
  if (record.ok === false) {
    return isFailureReason(record.reason)
      ? { type: "relay_auth_result", ok: false, reason: record.reason }
      : null;
  }
  if (record.ok !== true) return null;
  if (record.credential === undefined) return { type: "relay_auth_result", ok: true };
  const credential = record.credential;
  if (!isRecord(credential) || !isNonEmptyString(credential.id)) return null;
  if (!isNonEmptyString(credential.secret)) return null;
  return {
    type: "relay_auth_result",
    ok: true,
    credential: { id: credential.id, secret: credential.secret },
  };
}
