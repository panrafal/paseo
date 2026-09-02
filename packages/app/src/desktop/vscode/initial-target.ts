import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import { buildHostRootRoute, buildHostWorkspaceRoute } from "@/utils/host-routes";
import type { Href } from "expo-router";

export type VscodeWorkspaceMatch = { serverId: string; workspaceId: string } | { serverId: string };

export type VscodeStartupStatus = "connecting" | "loading-workspaces" | "opening";

export type VscodeStartupAction =
  | { kind: "none" }
  | { kind: "wait"; status: VscodeStartupStatus; detail: string | null }
  | { kind: "redirect"; match: VscodeWorkspaceMatch }
  | { kind: "open"; folder: string }
  | { kind: "error"; message: string };

export interface VscodeAutoOpenState {
  status: "idle" | "pending" | "error";
  folder: string | null;
  message: string | null;
}

export interface ResolveVscodeStartupActionInput {
  folders: readonly string[];
  hosts: readonly VscodeWorkspaceMatchHost[];
  hasConnectedHost: boolean;
  connectionDetail: string | null;
  autoOpen: VscodeAutoOpenState;
}

export interface VscodeWorkspaceMatchWorkspace {
  id: WorkspaceDescriptor["id"];
  projectId: WorkspaceDescriptor["projectId"];
  projectRootPath: WorkspaceDescriptor["projectRootPath"];
  workspaceDirectory: WorkspaceDescriptor["workspaceDirectory"];
  activityAt: WorkspaceDescriptor["activityAt"];
}

export interface VscodeWorkspaceMatchAgent {
  cwd: Agent["cwd"];
  workspaceId?: Agent["workspaceId"];
}

export interface VscodeWorkspaceMatchHost {
  serverId: string;
  hasHydratedAgents: boolean;
  hasHydratedWorkspaces: boolean;
  workspaces: Iterable<VscodeWorkspaceMatchWorkspace>;
  agents: Iterable<VscodeWorkspaceMatchAgent>;
}

export type VscodeWorkspaceMatchState =
  | { status: "loading" }
  | { status: "ready"; match: VscodeWorkspaceMatch | null };

export interface ResolveVscodeWorkspaceMatchInput {
  folders: readonly string[];
  hosts: readonly VscodeWorkspaceMatchHost[];
}

interface FirstUsableFolderPath {
  original: string;
  normalized: string;
}

function normalizePathForMatch(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) {
    return null;
  }

  const withUnixSeparators = trimmed.replace(/\\/g, "/");
  let normalized = withUnixSeparators.replace(/\/+$/, "");
  if (!normalized && withUnixSeparators.startsWith("/")) {
    normalized = "/";
  }
  if (/^[A-Za-z]:$/.test(normalized)) {
    normalized = `${normalized}/`;
  }
  if (!normalized) {
    return null;
  }

  if (/^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//")) {
    return normalized.toLowerCase();
  }
  return normalized;
}

function getFirstUsableFolderPath(folders: readonly string[]): FirstUsableFolderPath | null {
  for (const folder of folders) {
    const normalized = normalizePathForMatch(folder);
    if (normalized) {
      return { original: folder, normalized };
    }
  }
  return null;
}

function getFirstFolderPath(folders: readonly string[]): string | null {
  return getFirstUsableFolderPath(folders)?.normalized ?? null;
}

function isAutoOpenFolder(autoOpen: VscodeAutoOpenState, normalizedFolder: string): boolean {
  return normalizePathForMatch(autoOpen.folder) === normalizedFolder;
}

function getWorkspaceId(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || null;
}

function getActivityTime(workspace: VscodeWorkspaceMatchWorkspace): number {
  const parsed = workspace.activityAt ? Date.parse(workspace.activityAt) : Number.NaN;
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

/**
 * Several workspaces can legitimately sit on one directory: two checkouts of the same
 * repo folder, or a project root whose work happens in worktrees. Take the most
 * recently active one. Reporting "host only" instead sends startup through the host
 * index, which restores the last remembered workspace and lands the user in an
 * unrelated project.
 */
function pickLatestWorkspace(
  candidates: readonly VscodeWorkspaceMatchWorkspace[],
): VscodeWorkspaceMatchWorkspace | null {
  let latest: VscodeWorkspaceMatchWorkspace | null = null;
  let latestTime = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    const time = getActivityTime(candidate);
    // Ties keep the earlier candidate, so a host that reports no activity at all
    // resolves to the first workspace it listed.
    if (latest && time <= latestTime) {
      continue;
    }
    latest = candidate;
    latestTime = time;
  }
  return latest;
}

function buildLatestWorkspaceMatch(
  host: VscodeWorkspaceMatchHost,
  candidates: readonly VscodeWorkspaceMatchWorkspace[],
): VscodeWorkspaceMatch | null {
  const workspace = pickLatestWorkspace(candidates);
  return workspace ? { serverId: host.serverId, workspaceId: workspace.id } : null;
}

function isSameOrDescendantPath(child: string, parent: string): boolean {
  if (child === parent) {
    return true;
  }
  if (parent === "/") {
    return child.startsWith("/");
  }
  if (/^[a-z]:\/$/.test(parent)) {
    return child.startsWith(parent);
  }
  return child.startsWith(`${parent}/`);
}

function resolveProjectRootMatch(
  folderPath: string,
  host: VscodeWorkspaceMatchHost,
): VscodeWorkspaceMatch | null {
  return buildLatestWorkspaceMatch(
    host,
    Array.from(host.workspaces).filter(
      (workspace) => normalizePathForMatch(workspace.projectRootPath) === folderPath,
    ),
  );
}

function resolveWorkspaceDirMatch(
  folderPath: string,
  host: VscodeWorkspaceMatchHost,
): VscodeWorkspaceMatch | null {
  return buildLatestWorkspaceMatch(
    host,
    Array.from(host.workspaces).filter(
      (workspace) => normalizePathForMatch(workspace.workspaceDirectory) === folderPath,
    ),
  );
}

function resolveAgentCwdMatch(
  folderPath: string,
  host: VscodeWorkspaceMatchHost,
): VscodeWorkspaceMatch | null {
  const workspacesById = new Map(
    Array.from(host.workspaces, (workspace) => [workspace.id, workspace] as const),
  );
  const candidates = new Map<string, VscodeWorkspaceMatchWorkspace>();
  let matchedAgent = false;

  for (const agent of host.agents) {
    const cwd = normalizePathForMatch(agent.cwd);
    if (!cwd || !isSameOrDescendantPath(cwd, folderPath)) {
      continue;
    }
    matchedAgent = true;
    const workspaceId = getWorkspaceId(agent.workspaceId);
    const workspace = workspaceId ? workspacesById.get(workspaceId) : undefined;
    if (workspace) {
      candidates.set(workspace.id, workspace);
    }
  }

  if (!matchedAgent) {
    return null;
  }
  // An agent can name a workspace the host has not sent yet. Keep the host-only match
  // so startup still lands on the right daemon.
  return (
    buildLatestWorkspaceMatch(host, Array.from(candidates.values())) ?? { serverId: host.serverId }
  );
}

function resolveProjectRootMatchForHosts(
  folderPath: string,
  hosts: readonly VscodeWorkspaceMatchHost[],
): VscodeWorkspaceMatch | null {
  for (const host of hosts) {
    const match = resolveProjectRootMatch(folderPath, host);
    if (match) {
      return match;
    }
  }
  return null;
}

function resolveWorkspaceDirMatchForHosts(
  folderPath: string,
  hosts: readonly VscodeWorkspaceMatchHost[],
): VscodeWorkspaceMatch | null {
  for (const host of hosts) {
    const match = resolveWorkspaceDirMatch(folderPath, host);
    if (match) {
      return match;
    }
  }
  return null;
}

function resolveAgentCwdMatchForHosts(
  folderPath: string,
  hosts: readonly VscodeWorkspaceMatchHost[],
): VscodeWorkspaceMatch | null {
  for (const host of hosts) {
    const match = resolveAgentCwdMatch(folderPath, host);
    if (match) {
      return match;
    }
  }
  return null;
}

export function resolveVscodeWorkspaceMatch(
  input: ResolveVscodeWorkspaceMatchInput,
): VscodeWorkspaceMatch | null {
  const folderPath = getFirstFolderPath(input.folders);
  if (!folderPath) {
    return null;
  }

  return (
    resolveWorkspaceDirMatchForHosts(folderPath, input.hosts) ??
    resolveProjectRootMatchForHosts(folderPath, input.hosts) ??
    resolveAgentCwdMatchForHosts(folderPath, input.hosts)
  );
}

export function buildVscodeWorkspaceMatchHref(match: VscodeWorkspaceMatch): Href {
  if ("workspaceId" in match) {
    return buildHostWorkspaceRoute(match.serverId, match.workspaceId);
  }
  return buildHostRootRoute(match.serverId);
}

export function resolveVscodeStartupAction(
  input: ResolveVscodeStartupActionInput,
): VscodeStartupAction {
  const folderPath = getFirstUsableFolderPath(input.folders);
  if (!folderPath) {
    return { kind: "none" };
  }

  if (
    input.autoOpen.status === "error" &&
    isAutoOpenFolder(input.autoOpen, folderPath.normalized)
  ) {
    return { kind: "error", message: input.autoOpen.message ?? "Couldn't open this folder." };
  }

  if (
    input.autoOpen.status === "pending" &&
    isAutoOpenFolder(input.autoOpen, folderPath.normalized)
  ) {
    return { kind: "wait", status: "opening", detail: null };
  }

  if (!input.hasConnectedHost) {
    return { kind: "wait", status: "connecting", detail: input.connectionDetail };
  }

  if (input.hosts.length === 0 || input.hosts.some((host) => !host.hasHydratedWorkspaces)) {
    return { kind: "wait", status: "loading-workspaces", detail: null };
  }

  const match = resolveVscodeWorkspaceMatch({ folders: input.folders, hosts: input.hosts });
  if (match) {
    return { kind: "redirect", match };
  }

  return { kind: "open", folder: folderPath.original };
}

export function resolveVscodeWorkspaceMatchState(
  input: ResolveVscodeWorkspaceMatchInput,
): VscodeWorkspaceMatchState {
  const folderPath = getFirstFolderPath(input.folders);
  if (!folderPath || input.hosts.length === 0) {
    return { status: "ready", match: null };
  }

  if (input.hosts.some((host) => !host.hasHydratedWorkspaces)) {
    return { status: "loading" };
  }

  const workspaceDirMatch = resolveWorkspaceDirMatchForHosts(folderPath, input.hosts);
  if (workspaceDirMatch) {
    return { status: "ready", match: workspaceDirMatch };
  }

  const projectRootMatch = resolveProjectRootMatchForHosts(folderPath, input.hosts);
  if (projectRootMatch) {
    return { status: "ready", match: projectRootMatch };
  }

  if (input.hosts.some((host) => !host.hasHydratedAgents)) {
    return { status: "loading" };
  }

  return { status: "ready", match: resolveAgentCwdMatchForHosts(folderPath, input.hosts) };
}
