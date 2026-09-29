import pino from "pino";
import { expect, test, vi } from "vitest";
import type { AgentSession } from "../../agent/agent-sdk-types.js";
import type { SessionOutboundMessage } from "../../messages.js";
import { UsageSession } from "./usage-session.js";

test("collects live references for usage reports and resolves an agent report", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const references: unknown[] = [];
  const reference = { source: "fixture", input: { account: "one" } };
  const agent = {
    session: {
      getUsageReference: async () => reference,
    } as AgentSession,
  };
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
    listAgents: () => [agent, { session: null }],
    getAgent: (id) => (id === "one" ? agent : null),
    runtime: {
      async listUsageReports(options) {
        references.push(options.references);
        return [entry];
      },
      async resolveUsageReference(value) {
        references.push(value);
        return entry.id;
      },
      async listLegacyUsage() {
        return { fetchedAt: "2026-01-01T00:00:00.000Z", providers: [] };
      },
    },
    logger: pino({ level: "silent" }),
  });

  await usage.handleListReports({ type: "usage.list_reports.request", requestId: "list" });
  await usage.handleResolveAgentReport({
    type: "agent.resolve_usage_report.request",
    requestId: "one",
    agentId: "one",
  });
  expect(references).toEqual([[reference], reference]);
  expect(emitted.map((message) => message.type)).toEqual([
    "usage.list_reports.response",
    "agent.resolve_usage_report.response",
  ]);
});

test("surfaces a legacy usage-list failure as an rpc_error envelope", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const usage = new UsageSession({
    emit: (message) => emitted.push(message),
    listAgents: () => [],
    getAgent: () => null,
    runtime: {
      async listUsageReports() {
        return [];
      },
      async resolveUsageReference() {
        return null;
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

test("unknown agent returns agent_not_found", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const usage = new UsageSession({
    emit: (message) => emitted.push(message),
    listAgents: () => [],
    getAgent: () => null,
    runtime: {
      listUsageReports: async () => [],
      resolveUsageReference: async () => null,
      listLegacyUsage: async () => ({ fetchedAt: "", providers: [] }),
    },
    logger: pino({ level: "silent" }),
  });
  await usage.handleResolveAgentReport({
    type: "agent.resolve_usage_report.request",
    requestId: "missing",
    agentId: "missing",
  });
  expect(emitted[0]).toMatchObject({ type: "rpc_error", payload: { code: "agent_not_found" } });
});

test("forwards banked reset redemption and correlates the outcome", async () => {
  const emitted: SessionOutboundMessage[] = [];
  const consumeCodexBankedReset = vi.fn(async () => "nothing_to_reset" as const);
  const usage = new UsageSession({
    emit: (message) => emitted.push(message),
    listAgents: () => [],
    getAgent: () => null,
    runtime: {
      listUsageReports: async () => [],
      resolveUsageReference: async () => null,
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
    listAgents: () => [],
    getAgent: () => null,
    runtime: {
      listUsageReports: async () => [],
      resolveUsageReference: async () => null,
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
