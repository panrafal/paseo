import { describe, expect, it } from "vitest";
import { resolveNewWorkspaceRouteParams } from "./new-workspace-route-params";

describe("resolveNewWorkspaceRouteParams", () => {
  it("reads a URL-encoded prompt from the fragment", () => {
    expect(
      resolveNewWorkspaceRouteParams({
        "#": "q=Fix%20the%20bug%20%26%20add%20tests",
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
        "#": "q=Start%20here",
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

  it("ignores fragment fields other than q", () => {
    expect(
      resolveNewWorkspaceRouteParams({
        "#": "section=details",
      }).initialPrompt,
    ).toBeUndefined();
  });
});
