import { describe, expect, it } from "vitest";
import {
  readNewWorkspaceDeepLinkRoute,
  resolveNewWorkspaceRouteParams,
} from "./new-workspace-route-params";

describe("resolveNewWorkspaceRouteParams", () => {
  it("reads a prompt from the query parameters", () => {
    expect(
      resolveNewWorkspaceRouteParams({
        q: "Fix the bug & add tests",
      }).initialPrompt,
    ).toBe("Fix the bug & add tests");
  });

  it("preserves the supported query-string route context", () => {
    expect(
      resolveNewWorkspaceRouteParams({
        serverId: "server-1",
        dir: "/repo/project",
        name: "Project",
        projectId: "project-1",
        draftId: "draft-1",
        q: "Start here",
      }),
    ).toEqual({
      serverId: "server-1",
      sourceDirectory: "/repo/project",
      displayName: "Project",
      projectId: "project-1",
      draftId: "draft-1",
      initialPrompt: "Start here",
    });
  });

  it("ignores repeated prompt parameters", () => {
    expect(
      resolveNewWorkspaceRouteParams({
        q: ["first", "second"],
      }).initialPrompt,
    ).toBeUndefined();
  });
});

describe("readNewWorkspaceDeepLinkRoute", () => {
  it("rebuilds the new-workspace route with its project context and prompt", () => {
    expect(
      readNewWorkspaceDeepLinkRoute(
        "/new?serverId=srv_1&projectId=prj_1&dir=%2Frepo&name=repo&q=Fix%20it%0A%0A&extra=1",
      ),
    ).toBe("/new?serverId=srv_1&dir=%2Frepo&name=repo&projectId=prj_1&q=Fix+it%0A%0A");
  });

  it("round-trips the prompt through the route params", () => {
    const route = readNewWorkspaceDeepLinkRoute("/new?q=Fix%20auth%20%26%20add%20%23%20tests");
    expect(route).toBe("/new?q=Fix+auth+%26+add+%23+tests");
    const search = new URL(route ?? "", "http://localhost").searchParams;
    expect(search.get("q")).toBe("Fix auth & add # tests");
  });

  it("rejects routes other than New workspace", () => {
    for (const route of ["/", "/settings?q=Start", "/new/extra?q=Start", "//evil/new"]) {
      expect(readNewWorkspaceDeepLinkRoute(route)).toBeNull();
    }
  });
});
