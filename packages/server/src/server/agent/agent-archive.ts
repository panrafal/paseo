import type { StoredAgentRecord } from "./agent-storage.js";

export type ArchivedStoredAgentRecord = StoredAgentRecord & { archivedAt: string };

interface BuildArchivedAgentRecordOptions {
  archivedAt?: string;
  updatedAt?: string;
}

export function buildArchivedAgentRecord(
  record: StoredAgentRecord,
  options?: BuildArchivedAgentRecordOptions,
): ArchivedStoredAgentRecord {
  const archivedAt = options?.archivedAt ?? new Date().toISOString();
  return {
    ...record,
    archivedAt,
    updatedAt: options?.updatedAt ?? record.updatedAt,
    lastStatus: settleStoredAgentStatus(record.lastStatus),
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
  };
}

/**
 * A stored record with no live agent behind it cannot be busy: the process that
 * was running or initializing is gone. Archiving and stored-only projections
 * both report such a record as idle.
 */
export function settleStoredAgentStatus(
  status: StoredAgentRecord["lastStatus"],
): StoredAgentRecord["lastStatus"] {
  return status === "running" || status === "initializing" ? "idle" : status;
}
