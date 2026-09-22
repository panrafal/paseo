import { describe, expect, test } from "vitest";
import { ClaudeTaskState } from "./task-state.js";

function toolUse(id: string, name: string, input: Record<string, unknown>) {
  return { type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } };
}

function toolResult(id: string, result: Record<string, unknown>, failed = false) {
  return {
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          content: failed ? "error" : "ok",
          is_error: failed,
        },
      ],
    },
    toolUseResult: result,
  };
}

describe("ClaudeTaskState", () => {
  test("accumulates TaskCreate and TaskUpdate mutations by task id", () => {
    const state = new ClaudeTaskState();
    state.observe(
      toolUse("create-1", "TaskCreate", { subject: "Alpha", activeForm: "Doing alpha" }),
    );
    expect(state.observe(toolResult("create-1", { task: { id: "1", subject: "Alpha" } }))).toEqual({
      type: "todo",
      items: [
        {
          id: "create-1",
          text: "Alpha",
          activeForm: "Doing alpha",
          status: "pending",
          completed: false,
        },
      ],
    });

    state.observe(toolUse("update-1", "TaskUpdate", { taskId: "1", status: "in_progress" }));
    expect(state.observe(toolResult("update-1", { success: true, taskId: "1" }))).toEqual({
      type: "todo",
      items: [
        {
          id: "create-1",
          text: "Alpha",
          activeForm: "Doing alpha",
          status: "in_progress",
          completed: false,
        },
      ],
    });
  });

  test("removes deleted tasks and ignores replayed results", () => {
    const state = new ClaudeTaskState();
    state.observe(toolUse("create", "TaskCreate", { subject: "Disposable" }));
    state.observe(toolResult("create", { task: { id: "1", subject: "Disposable" } }));
    state.observe(toolUse("delete", "TaskUpdate", { taskId: "1", status: "deleted" }));
    const result = toolResult("delete", { success: true, taskId: "1" });
    expect(state.observe(result)).toEqual({ type: "todo", items: [] });
    expect(state.observe(result)).toBeNull();
  });

  test("preserves status when TaskUpdate changes only descriptive fields", () => {
    const state = new ClaudeTaskState();
    state.observe(toolUse("create", "TaskCreate", { subject: "Original" }));
    state.observe(toolResult("create", { task: { id: "1", subject: "Original" } }));
    state.observe(toolUse("complete", "TaskUpdate", { taskId: "1", status: "completed" }));
    state.observe(toolResult("complete", { success: true, taskId: "1" }));
    state.observe(toolUse("rename", "TaskUpdate", { taskId: "1", subject: "Renamed" }));

    expect(state.observe(toolResult("rename", { success: true, taskId: "1" }))).toEqual({
      type: "todo",
      items: [{ id: "create", text: "Renamed", status: "completed", completed: true }],
    });
  });

  test("replaces state from TodoWrite and TaskList snapshots", () => {
    const state = new ClaudeTaskState();
    expect(
      state.observe(
        toolUse("legacy", "TodoWrite", {
          todos: [{ content: "Legacy", status: "in_progress", activeForm: "Working" }],
        }),
      ),
    ).toEqual({
      type: "todo",
      items: [
        {
          id: "legacy:0",
          text: "Legacy",
          activeForm: "Working",
          status: "in_progress",
          completed: false,
        },
      ],
    });
    state.observe(toolUse("list", "TaskList", {}));
    expect(
      state.observe(
        toolResult("list", {
          tasks: [{ id: "7", subject: "Current", status: "completed", activeForm: "Finishing" }],
        }),
      ),
    ).toEqual({
      type: "todo",
      items: [
        { id: "7", text: "Current", activeForm: "Finishing", status: "completed", completed: true },
      ],
    });
  });

  test("keeps synthetic TodoWrite task ids stable across snapshots", () => {
    const state = new ClaudeTaskState();
    state.observe(
      toolUse("first", "TodoWrite", {
        todos: [{ content: "Stable", status: "pending" }],
      }),
    );

    expect(
      state.observe(
        toolUse("second", "TodoWrite", {
          todos: [{ content: "Stable", status: "completed" }],
        }),
      ),
    ).toEqual({
      type: "todo",
      items: [{ id: "legacy:0", text: "Stable", status: "completed", completed: true }],
    });
  });

  test("emits a TaskCreate snapshot before the result and keeps the pending id", () => {
    const state = new ClaudeTaskState();
    expect(
      state.observe(
        toolUse("create-1", "TaskCreate", { subject: "Alpha", activeForm: "Doing alpha" }),
      ),
    ).toEqual({
      type: "todo",
      items: [
        {
          id: "create-1",
          text: "Alpha",
          activeForm: "Doing alpha",
          status: "pending",
          completed: false,
        },
      ],
    });
    expect(state.observe(toolResult("create-1", { task: { id: "1", subject: "Alpha" } }))).toEqual({
      type: "todo",
      items: [
        {
          id: "create-1",
          text: "Alpha",
          activeForm: "Doing alpha",
          status: "pending",
          completed: false,
        },
      ],
    });
  });

  test("keeps client-visible ids stable when adding a task to an in-progress list", () => {
    const state = new ClaudeTaskState();
    state.observe(toolUse("create-1", "TaskCreate", { subject: "Alpha" }));
    state.observe(toolResult("create-1", { task: { id: "1", subject: "Alpha" } }));
    state.observe(toolUse("update-1", "TaskUpdate", { taskId: "1", status: "in_progress" }));
    state.observe(toolResult("update-1", { success: true, taskId: "1" }));
    state.observe(toolUse("create-2", "TaskCreate", { subject: "Gamma" }));

    expect(state.observe(toolResult("create-2", { task: { id: "3", subject: "Gamma" } }))).toEqual({
      type: "todo",
      items: [
        { id: "create-1", text: "Alpha", status: "in_progress", completed: false },
        { id: "create-2", text: "Gamma", status: "pending", completed: false },
      ],
    });
  });

  test("removes a pending TaskCreate when the tool fails", () => {
    const state = new ClaudeTaskState();
    state.observe(toolUse("create-1", "TaskCreate", { subject: "Alpha" }));
    expect(state.observe(toolResult("create-1", { success: false }))).toEqual({
      type: "todo",
      items: [],
    });
  });

  test("removes a pending TaskCreate when the tool_result is an error", () => {
    const state = new ClaudeTaskState();
    state.observe(toolUse("create-1", "TaskCreate", { subject: "Alpha" }));
    expect(state.observe(toolResult("create-1", {}, true))).toEqual({
      type: "todo",
      items: [],
    });
  });

  test("reads TaskCreate results from tool_result JSON when toolUseResult is missing", () => {
    const state = new ClaudeTaskState();
    state.observe(toolUse("create-1", "TaskCreate", { subject: "Alpha" }));
    expect(
      state.observe({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "create-1",
              content: JSON.stringify({ task: { id: "9", subject: "Alpha" } }),
            },
          ],
        },
      }),
    ).toEqual({
      type: "todo",
      items: [{ id: "create-1", text: "Alpha", status: "pending", completed: false }],
    });
  });

  test("does not confuse Claude's subagent Task tool with task tracking", () => {
    const state = new ClaudeTaskState();
    expect(state.observe(toolUse("subagent", "Task", { description: "delegate" }))).toBeNull();
  });
});
