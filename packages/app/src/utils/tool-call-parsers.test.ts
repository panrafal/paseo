import { describe, expect, it } from "vitest";

import {
  buildLineDiff,
  parseUnifiedDiff,
  extractTaskEntriesFromToolCall,
} from "./tool-call-parsers";

describe("tool-call-parsers", () => {
  it("builds line diff for text changes", () => {
    const diff = buildLineDiff("old\nline\n", "new\nline\n");

    expect(diff.some((entry) => entry.type === "remove")).toBe(true);
    expect(diff.some((entry) => entry.type === "add")).toBe(true);
  });

  it("parses unified diff", () => {
    const parsed = parseUnifiedDiff("@@\n-old\n+new\n");

    expect(parsed.find((entry) => entry.type === "remove")?.content).toBe("-old");
    expect(parsed.find((entry) => entry.type === "add")?.content).toBe("+new");
  });

  it("extracts TodoWrite task entries", () => {
    const tasks = extractTaskEntriesFromToolCall("TodoWrite", {
      todos: [
        { content: "Task 1", status: "pending" },
        { content: "Task 2", status: "completed" },
      ],
    });

    expect(tasks?.map((task) => task.text)).toEqual(["Task 1", "Task 2"]);
    expect(tasks?.map((task) => task.completed)).toEqual([false, true]);
  });

  it("extracts Cursor updateTodos task entries from unknown ACP tool input", () => {
    const tasks = extractTaskEntriesFromToolCall("other", {
      _toolName: "updateTodos",
      todos: [
        { id: "a", content: "Inspect provider", status: 1 },
        { id: "b", content: "Ship fix", status: 2 },
      ],
    });

    expect(tasks).toEqual([
      { text: "Inspect provider", status: "in_progress", completed: false },
      { text: "Ship fix", status: "completed", completed: true },
    ]);
  });
});
