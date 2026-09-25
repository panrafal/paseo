import { useEffect } from "react";
import { router } from "expo-router";
import { listenToDesktopEvent } from "@/desktop/electron/events";
import { getDesktopHost } from "@/desktop/host";
import { useStableEvent } from "@/hooks/use-stable-event";
import { readNewWorkspaceDeepLinkRoute } from "@/navigation/new-workspace-route-params";
import { navigateToAgent } from "@/utils/navigate-to-agent";

interface NavigateEventPayload {
  kind?: unknown;
  serverId?: unknown;
  agentId?: unknown;
  route?: unknown;
}

function openAgent(payload: NavigateEventPayload): void {
  const serverId = typeof payload.serverId === "string" ? payload.serverId.trim() : "";
  const agentId = typeof payload.agentId === "string" ? payload.agentId.trim() : "";
  if (!serverId || !agentId) {
    return;
  }
  navigateToAgent({ serverId, agentId });
}

function openNewWorkspace(payload: NavigateEventPayload): void {
  const route =
    typeof payload.route === "string" ? readNewWorkspaceDeepLinkRoute(payload.route) : null;
  if (route) {
    router.push(route);
  }
}

export function DesktopNavigationListener() {
  const navigate = useStableEvent((payload: NavigateEventPayload | null) => {
    if (payload?.kind === "agent") {
      openAgent(payload);
    } else if (payload?.kind === "new-workspace") {
      openNewWorkspace(payload);
    }
  });

  useEffect(() => {
    const host = getDesktopHost();
    const ready = host?.navigation?.ready;
    if (typeof host?.events?.on !== "function" || typeof ready !== "function") {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = async () => {
      let dispose: (() => void) | null = null;
      try {
        dispose = await listenToDesktopEvent<NavigateEventPayload>("navigate", navigate);
        if (disposed) {
          dispose();
          return;
        }
        unlisten = dispose;
        const pending = await ready();
        if (!disposed && pending && typeof pending === "object") {
          navigate(pending);
        }
      } catch {
        dispose?.();
        if (unlisten === dispose) {
          unlisten = null;
        }
        if (!disposed) {
          retryTimer = setTimeout(() => void connect(), 1_000);
        }
      }
    };

    void connect();

    return () => {
      disposed = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
      unlisten?.();
    };
  }, [navigate]);

  return null;
}
