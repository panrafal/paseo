import { describe, expect, test } from "vitest";

import { resolveDevinSlashCommandKind } from "./devin-acp-agent.js";

describe("resolveDevinSlashCommandKind", () => {
  test("classifies commands tagged with the Skills category as skills", () => {
    expect(
      resolveDevinSlashCommandKind({
        name: "plan",
        description: "Draft a plan for the requested work",
        _meta: { "cognition.ai/category": "Skills" },
      }),
    ).toBe("skill");
  });

  test("keeps built-in categories as commands", () => {
    expect(
      resolveDevinSlashCommandKind({
        name: "compact",
        description: "Compact the session",
        _meta: { "cognition.ai/category": "Session" },
      }),
    ).toBe("command");
  });

  test("defaults to command when the command carries no metadata", () => {
    expect(
      resolveDevinSlashCommandKind({
        name: "review",
        description: "Review the workspace changes",
      }),
    ).toBe("command");
  });
});
