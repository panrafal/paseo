import { buildNewWorkspaceRoute } from "@/utils/host-routes";

export interface NewWorkspaceRouteParams {
  serverId?: string | string[];
  dir?: string | string[];
  name?: string | string[];
  projectId?: string | string[];
  draftId?: string | string[];
  q?: string | string[];
}

export interface ResolvedNewWorkspaceRouteParams {
  serverId: string;
  sourceDirectory: string | undefined;
  displayName: string | undefined;
  projectId: string | undefined;
  draftId: string | undefined;
  initialPrompt: string | undefined;
}

function singleParam(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function resolveNewWorkspaceRouteParams(
  params: NewWorkspaceRouteParams,
): ResolvedNewWorkspaceRouteParams {
  return {
    serverId: singleParam(params.serverId) ?? "",
    sourceDirectory: singleParam(params.dir),
    displayName: singleParam(params.name),
    projectId: singleParam(params.projectId),
    draftId: singleParam(params.draftId),
    initialPrompt: singleParam(params.q),
  };
}

// Desktop deep links arrive as a route string from the main process. Rebuild the
// route from its known parameters instead of navigating to whatever was sent.
export function readNewWorkspaceDeepLinkRoute(
  route: string,
): ReturnType<typeof buildNewWorkspaceRoute> | null {
  const base = "http://localhost";
  let url: URL;
  try {
    url = new URL(route, base);
  } catch {
    return null;
  }
  if (url.origin !== base || url.pathname !== "/new") {
    return null;
  }
  const params = resolveNewWorkspaceRouteParams({
    serverId: url.searchParams.get("serverId") ?? undefined,
    dir: url.searchParams.get("dir") ?? undefined,
    name: url.searchParams.get("name") ?? undefined,
    projectId: url.searchParams.get("projectId") ?? undefined,
    draftId: url.searchParams.get("draftId") ?? undefined,
    q: url.searchParams.get("q") ?? undefined,
  });
  return buildNewWorkspaceRoute(params);
}
