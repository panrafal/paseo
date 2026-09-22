import {
  buildAgentDeepLinkRoute,
  parseAgentDeepLink,
  type AgentDeepLinkTarget,
} from "@getpaseo/protocol/agent-deep-link";
import { parseNewWorkspaceDeepLink } from "./new-workspace-navigation.js";

export type DesktopNavigationTarget =
  | ({ kind: "agent" } & AgentDeepLinkTarget)
  | { kind: "new-workspace"; route: string };

export function parseDesktopDeepLink(input: unknown): DesktopNavigationTarget | null {
  if (typeof input !== "string") {
    return null;
  }
  const newWorkspaceRoute = parseNewWorkspaceDeepLink(input);
  if (newWorkspaceRoute) {
    return { kind: "new-workspace", route: newWorkspaceRoute };
  }
  const agent = parseAgentDeepLink(input);
  return agent ? { kind: "agent", ...agent } : null;
}

export function findDesktopDeepLink(argv: string[]): string | null {
  return argv.find((arg) => parseDesktopDeepLink(arg) !== null) ?? null;
}

export function buildDesktopNavigationRoute(target: DesktopNavigationTarget): string {
  return target.kind === "agent" ? buildAgentDeepLinkRoute(target) : target.route;
}

// macOS hands a launch link to the new process through open-url, never argv, so a
// process that loses the single-instance lock forwards it as lock data.
export function buildForwardedDeepLinkData(
  deepLink: string | null,
): { deepLink: string } | undefined {
  return deepLink ? { deepLink } : undefined;
}

export function readForwardedDeepLink(data: unknown): string | null {
  if (typeof data !== "object" || data === null || !("deepLink" in data)) {
    return null;
  }
  return typeof data.deepLink === "string" ? data.deepLink : null;
}

export class DesktopNavigationInbox {
  private readonly readyWindows = new Set<number>();
  private readonly pendingByWindow = new Map<number, DesktopNavigationTarget>();

  windowLoading(webContentsId: number): void {
    this.readyWindows.delete(webContentsId);
  }

  windowReady(webContentsId: number): DesktopNavigationTarget | null {
    this.readyWindows.add(webContentsId);
    const pending = this.pendingByWindow.get(webContentsId) ?? null;
    this.pendingByWindow.delete(webContentsId);
    return pending;
  }

  deliverOrQueue(
    webContentsId: number,
    target: DesktopNavigationTarget,
  ): DesktopNavigationTarget | null {
    if (this.readyWindows.has(webContentsId)) {
      return target;
    }
    this.pendingByWindow.set(webContentsId, target);
    return null;
  }

  removeWindow(webContentsId: number): void {
    this.readyWindows.delete(webContentsId);
    this.pendingByWindow.delete(webContentsId);
  }
}
