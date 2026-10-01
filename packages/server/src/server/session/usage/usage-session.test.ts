import pino from "pino";
import { expect, test, vi } from "vitest";
import type { SessionOutboundMessage } from "../../messages.js";
import { UsageSession } from "./usage-session.js";

test("lists reports from usage sources", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const requested: Array<{ forceRefresh?: boolean; reportIds?: string[] }> = [];
  const entry = {
    id: "fixture:one",
    account: {},
    fetchedAt: "2026-01-01T00:00:00.000Z",
    sourceId: "fixture",
    sourceLabel: "Fixture",
    report: { status: "available" as const, windows: [] },
  };
  const usage = new UsageSession({
    emit: (message) => emitted.push(message),
    runtime: {
      async listUsageReports(options) {
        requested.push(options);
        return [entry];
      },
      async listLegacyUsage() {
        return { fetchedAt: "2026-01-01T00:00:00.000Z", providers: [] };
      },
    },
    logger: pino({ level: "silent" }),
  });

  await usage.handleListReports({ type: "usage.list_reports.request", requestId: "list" });
  expect(requested).toEqual([{ forceRefresh: undefined, reportIds: undefined }]);
  expect(emitted).toEqual([
    { type: "usage.list_reports.response", payload: { requestId: "list", reports: [entry] } },
  ]);
});

test("surfaces a legacy usage-list failure as an rpc_error envelope", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const usage = new UsageSession({
    emit: (message) => emitted.push(message),
    runtime: {
      async listUsageReports() {
        return [];
      },
      async listLegacyUsage(): Promise<never> {
        throw new Error("quota service down");
      },
    },
    logger: pino({ level: "silent" }),
  });
  await usage.handleLegacyList({ type: "provider.usage.list.request", requestId: "u1" });
  expect(emitted[0]).toMatchObject({
    type: "rpc_error",
    payload: { requestId: "u1", code: "provider_usage_list_failed" },
  });
});
test("forwards banked reset redemption and correlates the outcome", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const consumeCodexBankedReset = vi.fn(async () => "nothing_to_reset" as const);
  const usage = new UsageSession({
    emit: (message) => emitted.push(message),
    runtime: {
      listUsageReports: async () => [],
      listLegacyUsage: async () => ({ fetchedAt: "", providers: [] }),
      consumeCodexBankedReset,
    },
    logger: pino({ level: "silent" }),
  });
  await usage.handleCodexBankedResetConsumeRequest({
    type: "provider.codex.consume_banked_reset.request",
    requestId: "request-1",
    creditId: "reset-1",
    idempotencyKey: "attempt-1",
  });
  expect(consumeCodexBankedReset).toHaveBeenCalledWith({
    creditId: "reset-1",
    idempotencyKey: "attempt-1",
  });
  expect(emitted).toEqual([
    {
      type: "provider.codex.consume_banked_reset.response",
      payload: { requestId: "request-1", outcome: "nothing_to_reset" },
    },
  ]);
});

test("returns a correlated error when banked reset redemption fails", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const usage = new UsageSession({
    emit: (message) => emitted.push(message),
    runtime: {
      listUsageReports: async () => [],
      listLegacyUsage: async () => ({ fetchedAt: "", providers: [] }),
      consumeCodexBankedReset: async () => {
        throw new Error("Request timed out");
      },
    },
    logger: pino({ level: "silent" }),
  });
  await usage.handleCodexBankedResetConsumeRequest({
    type: "provider.codex.consume_banked_reset.request",
    requestId: "request-1",
    creditId: "reset-1",
    idempotencyKey: "attempt-1",
  });
  expect(emitted).toEqual([
    {
      type: "rpc_error",
      payload: {
        requestId: "request-1",
        requestType: "provider.codex.consume_banked_reset.request",
        error: "Could not use banked reset: Request timed out",
        code: "codex_banked_reset_failed",
      },
    },
  ]);
});
