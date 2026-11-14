import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import type { connectToDaemon } from "./client.js";

type FetchAgentsOptions = NonNullable<
  Parameters<Awaited<ReturnType<typeof connectToDaemon>>["fetchAgents"]>[0]
>;

interface AgentDirectoryClient<TAgent = AgentSnapshotPayload> {
  fetchAgents(options?: FetchAgentsOptions): Promise<{
    entries: { agent: TAgent }[];
    pageInfo: { nextCursor: string | null };
  }>;
}

/** Read the complete directory without agents moving between pages as they update. */
export async function fetchAllAgents<TAgent = AgentSnapshotPayload>(
  client: AgentDirectoryClient<TAgent>,
  options: Omit<FetchAgentsOptions, "page" | "sort" | "subscribe"> = {},
): Promise<TAgent[]> {
  const agents: TAgent[] = [];
  let cursor: string | undefined;
  // createdAt never changes, so agents cannot move past the cursor while the pages are read.
  do {
    const payload = await client.fetchAgents({
      ...options,
      sort: [{ key: "created_at", direction: "desc" }],
      page: { limit: 200, ...(cursor ? { cursor } : {}) },
    });
    agents.push(...payload.entries.map((entry) => entry.agent));
    cursor = payload.pageInfo.nextCursor ?? undefined;
  } while (cursor);
  return agents;
}
