import { describe, expect, test } from "vitest";

import {
  AcpTaskState,
  isAcpTodoMerge,
  isAcpTodoToolInput,
  mapPlanEntriesToTodo,
  parseAcpTodoItems,
} from "./acp-task-state.js";

describe("parseAcpTodoItems", () => {
  test("maps Cursor updateTodos payloads including protobuf status enums", () => {
    expect(
      parseAcpTodoItems({
        _toolName: "updateTodos",
        todos: [
          { id: "a", content: "Inspect provider", status: 1 },
          { id: "b", content: "Ship fix", status: 2 },
          { id: "c", content: "Cancelled leftover", status: 3 },
        ],
      }),
    ).toEqual([
      { id: "a", text: "Inspect provider", status: "in_progress", completed: false },
      { id: "b", text: "Ship fix", status: "completed", completed: true },
    ]);
  });

  test("returns an empty list for an explicit clear", () => {
    expect(parseAcpTodoItems({ todos: [] })).toEqual([]);
  });
});

describe("isAcpTodoToolInput", () => {
  test("recognizes Cursor updateTodos tool calls", () => {
    expect(
      isAcpTodoToolInput(
        { _toolName: "updateTodos", todos: [{ id: "1", content: "Alpha", status: 0 }] },
        "Update TODOs: Alpha",
      ),
    ).toBe(true);
  });

  test("does not treat unrelated ACP tools as todos", () => {
    expect(
      isAcpTodoToolInput({ path: "/tmp/example.ts", contents: "export {}" }, "Edit example.ts"),
    ).toBe(false);
  });
});

describe("AcpTaskState", () => {
  test("replaces on ACP plan updates and merges Cursor partial updates", () => {
    const state = new AcpTaskState();
    expect(
      state.replace(
        mapPlanEntriesToTodo([
          { content: "Inspect", status: "in_progress" },
          { content: "Ship", status: "pending" },
        ]).items,
      ),
    ).toEqual({
      type: "todo",
      items: [
        { id: "0", text: "Inspect", status: "in_progress", completed: false },
        { id: "1", text: "Ship", status: "pending", completed: false },
      ],
    });

    expect(
      state.apply(
        [{ id: "1", text: "Ship", status: "completed", completed: true }],
        isAcpTodoMerge({ merge: true }),
      ),
    ).toEqual({
      type: "todo",
      items: [
        { id: "0", text: "Inspect", status: "in_progress", completed: false },
        { id: "1", text: "Ship", status: "completed", completed: true },
      ],
    });
  });
});
