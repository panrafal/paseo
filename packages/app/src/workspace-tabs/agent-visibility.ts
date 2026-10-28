import type { Agent } from "@/stores/session-store";
import type { WorkspaceTabSnapshot } from "@/stores/workspace-layout-actions";
import { isWorkspaceRootAgent } from "@/subagents/policies";
import { normalizeWorkspaceOpaqueId, normalizeWorkspacePath } from "@/utils/workspace-identity";

export interface WorkspaceAgentVisibility {
  activeAgentIds: Set<string>;
  autoOpenAgentIds: Set<string>;
  foreignAgentIds: Set<string>;
}

function agentBelongsToWorkspace(input: {
  agent: Agent;
  workspaceId: string;
  workspaceDirectory: string | null;
}): boolean {
  const agentWorkspaceId = normalizeWorkspaceOpaqueId(input.agent.workspaceId);
  if (agentWorkspaceId) {
    return agentWorkspaceId === input.workspaceId;
  }

  // COMPAT(legacyAgentWorkspaceId): added 2026-06-18, remove after 2026-12-18 once daemon/storage floor always stamps workspaceId.
  return normalizeWorkspacePath(input.agent.cwd) === input.workspaceDirectory;
}

function addForeignAgent(input: {
  agent: Agent;
  workspaceId: string;
  foreignAgentIds: Set<string>;
}): void {
  const ownerId = normalizeWorkspaceOpaqueId(input.agent.workspaceId);
  if (ownerId && ownerId !== input.workspaceId) {
    input.foreignAgentIds.add(input.agent.id);
  }
}

function addSessionAgentVisibility(input: {
  agent: Agent;
  sessionAgents: Map<string, Agent> | undefined;
  agentDetails: Map<string, Agent> | undefined;
  workspaceId: string;
  workspaceDirectory: string | null;
  activeAgentIds: Set<string>;
  autoOpenAgentIds: Set<string>;
  foreignAgentIds: Set<string>;
}): void {
  if (!agentBelongsToWorkspace(input)) {
    addForeignAgent(input);
    return;
  }
  if (input.agent.archivedAt) {
    return;
  }

  input.activeAgentIds.add(input.agent.id);
  const parentAgent = input.agent.parentAgentId
    ? (input.sessionAgents?.get(input.agent.parentAgentId) ??
      input.agentDetails?.get(input.agent.parentAgentId))
    : undefined;
  if (isWorkspaceRootAgent(input.agent, parentAgent)) {
    input.autoOpenAgentIds.add(input.agent.id);
  }
}

export function deriveWorkspaceAgentVisibility(input: {
  sessionAgents: Map<string, Agent> | undefined;
  agentDetails?: Map<string, Agent> | undefined;
  workspaceId: string | null | undefined;
  workspaceDirectory?: string | null | undefined;
}): WorkspaceAgentVisibility {
  const { sessionAgents, agentDetails } = input;
  const workspaceId = normalizeWorkspaceOpaqueId(input.workspaceId);
  const workspaceDirectory = normalizeWorkspacePath(input.workspaceDirectory);
  if ((!sessionAgents && !agentDetails) || !workspaceId) {
    return {
      activeAgentIds: new Set<string>(),
      autoOpenAgentIds: new Set<string>(),
      foreignAgentIds: new Set<string>(),
    };
  }

  const activeAgentIds = new Set<string>();
  const autoOpenAgentIds = new Set<string>();
  const foreignAgentIds = new Set<string>();
  for (const agent of sessionAgents?.values() ?? []) {
    addSessionAgentVisibility({
      agent,
      sessionAgents,
      agentDetails,
      workspaceId,
      workspaceDirectory,
      activeAgentIds,
      autoOpenAgentIds,
      foreignAgentIds,
    });
  }
  for (const agent of agentDetails?.values() ?? []) {
    if (!sessionAgents?.has(agent.id)) {
      addForeignAgent({ agent, workspaceId, foreignAgentIds });
    }
  }
  return { activeAgentIds, autoOpenAgentIds, foreignAgentIds };
}

interface AgentMapsSnapshot {
  sessions: Record<
    string,
    { agents: Map<string, Agent>; agentDetails: Map<string, Agent> } | undefined
  >;
}

// Session-store selectors run on every store update, including every stream tick, which
// leaves the agent maps untouched. Reuse the previous result until either map changes, and
// keep it when a recompute yields the same sets so the hook's equality check stays O(1).
export function createWorkspaceAgentVisibilitySelector(input: {
  serverId: string;
  workspaceId: string | null | undefined;
  workspaceDirectory?: string | null | undefined;
}): (state: AgentMapsSnapshot) => WorkspaceAgentVisibility {
  let previousAgents: Map<string, Agent> | undefined;
  let previousAgentDetails: Map<string, Agent> | undefined;
  let previousVisibility: WorkspaceAgentVisibility | null = null;

  return (state) => {
    const session = state.sessions[input.serverId];
    const agents = session?.agents;
    const agentDetails = session?.agentDetails;
    if (previousVisibility && agents === previousAgents && agentDetails === previousAgentDetails) {
      return previousVisibility;
    }

    const visibility = deriveWorkspaceAgentVisibility({
      sessionAgents: agents,
      agentDetails,
      workspaceId: input.workspaceId,
      workspaceDirectory: input.workspaceDirectory,
    });
    previousAgents = agents;
    previousAgentDetails = agentDetails;
    if (!previousVisibility || !workspaceAgentVisibilityEqual(previousVisibility, visibility)) {
      previousVisibility = visibility;
    }
    return previousVisibility;
  };
}

export function buildWorkspaceTabSnapshot(input: {
  agentVisibility: WorkspaceAgentVisibility;
  agentsHydrated: boolean;
  terminalsHydrated: boolean;
  knownTerminalIds: Iterable<string>;
  standaloneTerminalIds: Iterable<string>;
  hasActivePendingTerminalCreate: boolean;
  hasActivePendingDraftCreate: boolean;
}): WorkspaceTabSnapshot {
  return {
    agentsHydrated: input.agentsHydrated,
    terminalsHydrated: input.terminalsHydrated,
    activeAgentIds: input.agentVisibility.activeAgentIds,
    autoOpenAgentIds: input.agentVisibility.autoOpenAgentIds,
    foreignAgentIds: input.agentVisibility.foreignAgentIds,
    knownTerminalIds: input.knownTerminalIds,
    standaloneTerminalIds: input.standaloneTerminalIds,
    hasActivePendingTerminalCreate: input.hasActivePendingTerminalCreate,
    hasActivePendingDraftCreate: input.hasActivePendingDraftCreate,
  };
}

export function workspaceAgentVisibilityEqual(
  a: WorkspaceAgentVisibility,
  b: WorkspaceAgentVisibility,
): boolean {
  return (
    a === b ||
    (setsEqual(a.activeAgentIds, b.activeAgentIds) &&
      setsEqual(a.autoOpenAgentIds, b.autoOpenAgentIds) &&
      setsEqual(a.foreignAgentIds, b.foreignAgentIds))
  );
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const item of a) {
    if (!b.has(item)) {
      return false;
    }
  }
  return true;
}

// Prune agent tabs that are no longer active once agents are hydrated.
// Archived agents get pruned so that archiving on one client closes the tab on all clients.
export function shouldPruneWorkspaceAgentTab(input: {
  agentId: string;
  agentsHydrated: boolean;
  activeAgentIds: Set<string>;
}): boolean {
  if (!input.agentId.trim()) {
    return false;
  }
  if (!input.agentsHydrated) {
    return false;
  }
  return !input.activeAgentIds.has(input.agentId);
}
