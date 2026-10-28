import { describe, expect, it } from "vitest";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { renderJson, renderTable, type OutputOptions } from "../../output/index.js";
import {
  buildAgentLsFetchOptions,
  listAgents,
  runLsCommandWithDeps,
  type AgentListSource,
  type AgentLsClient,
  type AgentLsDeps,
  type FetchAgentsOptions,
} from "./ls.js";

const daemonTarget = { kind: "endpoint" as const, host: "example.test:12345" };

const plainOutput: OutputOptions = {
  format: "table",
  quiet: false,
  noHeaders: true,
  noColor: true,
};

function agent(overrides: Partial<AgentListSource> = {}): AgentListSource {
  return {
    id: "agent-1234567890",
    title: "Fix login",
    provider: "claude",
    model: "claude-opus-5",
    effectiveThinkingOptionId: "high",
    status: "idle",
    cwd: "/tmp/project",
    createdAt: new Date().toISOString(),
    labels: { team: "platform", "paseo.worktree": "feature-auth" },
    ...overrides,
  };
}

class FakeAgentLsClient implements AgentLsClient {
  readonly requests: Array<FetchAgentsOptions | undefined> = [];
  closed = false;

  constructor(private readonly agents: AgentListSource[]) {}

  async fetchAgents(options?: FetchAgentsOptions) {
    this.requests.push(options);
    return {
      entries: this.agents.map((entry) => ({ agent: entry })),
      pageInfo: { nextCursor: null },
    };
  }

  async close() {
    this.closed = true;
  }
}

function depsFor(client: AgentLsClient): AgentLsDeps {
  return { connectToDaemon: async () => client };
}

function createPagingClient(): AgentLsClient {
  const daemonAgents: AgentSnapshotPayload[] = [3, 2, 1].map((n) => ({
    id: `${n}${n}${n}${n}${n}${n}${n}${n}-0000-4000-8000-000000000000`,
    provider: "codex",
    title: `agent ${n}`,
    status: "closed",
    archivedAt: null,
    cwd: "/tmp/project",
    createdAt: `2026-10-0${n}T00:00:00.000Z`,
    updatedAt: `2026-10-0${n}T00:00:00.000Z`,
    labels: {},
    model: null,
    lastUserMessageAt: null,
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: false,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
  }));

  // created_at is stable while the daemon updates agent 1 after serving the first page.
  const fetchAgents = async (options?: FetchAgentsOptions) => {
    const key: "createdAt" | "updatedAt" =
      options?.sort?.[0]?.key === "created_at" ? "createdAt" : "updatedAt";
    const cursor = options?.page?.cursor;
    const ordered = daemonAgents
      .filter((entry) => cursor === undefined || entry[key] < cursor)
      .sort((left, right) => right[key].localeCompare(left[key]));
    const page = ordered.slice(0, 2);
    const hasMore = ordered.length > 2;
    if (cursor === undefined) {
      daemonAgents[2]!.updatedAt = "2026-10-09T00:00:00.000Z";
    }
    return {
      entries: page.map((entry) => ({ agent: entry })),
      pageInfo: { nextCursor: hasMore ? page[page.length - 1]![key] : null },
    };
  };
  return { fetchAgents, close: async () => {} };
}

describe("buildAgentLsFetchOptions", () => {
  it("fetches active agents by default", () => {
    expect(buildAgentLsFetchOptions({})).toEqual({
      scope: "active",
    });
  });

  it("keeps label and thinking filters within the active scope", () => {
    expect(
      buildAgentLsFetchOptions({
        label: ["surface=workspace"],
        thinking: " medium ",
      }),
    ).toEqual({
      scope: "active",
      filter: {
        labels: { surface: "workspace" },
        thinkingOptionId: "medium",
      },
    });
  });

  it("asks the daemon for internal agents only with --internal", () => {
    expect(buildAgentLsFetchOptions({ background: true, global: true })).toEqual({
      filter: { includeBackground: true },
    });
  });

  it("fetches global non-archived agents for -g", () => {
    expect(buildAgentLsFetchOptions({ global: true })).toEqual({});
  });

  it("includes archived and background agents with -a", () => {
    expect(buildAgentLsFetchOptions({ all: true })).toEqual({
      filter: {
        includeArchived: true,
        includeBackground: true,
      },
    });
  });

  it("fetches all global agents for -a -g", () => {
    expect(buildAgentLsFetchOptions({ all: true, global: true })).toEqual({
      filter: {
        includeArchived: true,
        includeBackground: true,
      },
    });
  });

  it("applies filters to global queries", () => {
    expect(
      buildAgentLsFetchOptions({
        global: true,
        label: ["surface=workspace"],
        thinking: " medium ",
      }),
    ).toEqual({
      filter: {
        labels: { surface: "workspace" },
        thinkingOptionId: "medium",
      },
    });
  });
});

describe("runLsCommand", () => {
  it("lists agents on every page, including one updated during the listing", async () => {
    const result = await listAgents({ daemonTarget, all: true, global: true }, async () =>
      createPagingClient(),
    );

    expect(result.data.map((item) => item.name)).toEqual(["agent 3", "agent 2", "agent 1"]);
  });
});

describe("agent ls", () => {
  it("includes labels in structured output but not in the table", async () => {
    const client = new FakeAgentLsClient([agent()]);

    const result = await runLsCommandWithDeps({ daemonTarget, global: true }, depsFor(client));

    expect(client.closed).toBe(true);
    expect(result.data).toEqual([
      expect.objectContaining({
        id: "agent-1234567890",
        shortId: "agent-1",
        name: "Fix login",
        provider: "claude/claude-opus-5",
        thinking: "high",
        status: "idle",
        cwd: "/tmp/project",
        labels: { team: "platform", "paseo.worktree": "feature-auth" },
      }),
    ]);

    const json = JSON.parse(renderJson(result, plainOutput));
    expect(json[0].labels).toEqual({ team: "platform", "paseo.worktree": "feature-auth" });

    const table = renderTable(result, plainOutput);
    expect(table).toContain("Fix login");
    expect(table).not.toContain("platform");
  });

  it("filters by label on the host and again on the returned agents", async () => {
    const client = new FakeAgentLsClient([
      agent(),
      agent({ id: "agent-0987654321", title: "Docs", labels: { team: "docs" } }),
    ]);

    const result = await runLsCommandWithDeps(
      { daemonTarget, label: ["team=platform"] },
      depsFor(client),
    );

    expect(client.requests).toEqual([
      {
        scope: "active",
        filter: { labels: { team: "platform" } },
        sort: [{ key: "created_at", direction: "desc" }],
        page: { limit: 200 },
      },
    ]);
    expect(result.data.map((item) => item.id)).toEqual(["agent-1234567890"]);
  });
});
