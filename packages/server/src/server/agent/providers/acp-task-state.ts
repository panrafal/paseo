import type { AgentTaskItem, AgentTimelineItem } from "../agent-sdk-types.js";

export const CURSOR_UPDATE_TODOS_METHOD = "cursor/update_todos";

const TODO_TOOL_NAMES = new Set(["updatetodos", "update_todos", "todowrite", "todo_write"]);

type TodoSnapshot = Extract<AgentTimelineItem, { type: "todo" }>;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeName(value: string): string {
  return value
    .trim()
    .replace(/[.\s-]+/g, "_")
    .toLowerCase();
}

function taskStatus(value: unknown): AgentTaskItem["status"] | "deleted" {
  if (value === "completed") return "completed";
  if (value === "in_progress" || value === "inProgress") return "in_progress";
  if (value === "cancelled" || value === "canceled" || value === "deleted") return "deleted";
  if (value === 2) return "completed";
  if (value === 1) return "in_progress";
  if (value === 3) return "deleted";
  return "pending";
}

function toTaskItem(value: unknown, index: number): AgentTaskItem | null {
  const task = record(value);
  if (!task) return null;
  const text =
    string(task.content) ?? string(task.subject) ?? string(task.text) ?? string(task.step);
  if (!text) return null;
  const status = taskStatus(task.status);
  if (status === "deleted") return null;
  const id = string(task.id) ?? string(task.taskId) ?? String(index);
  const activeForm = string(task.activeForm) ?? string(task.active_form);
  return {
    id,
    text,
    status,
    completed: status === "completed",
    ...(activeForm ? { activeForm } : {}),
  };
}

export function parseAcpTodoItems(value: unknown): AgentTaskItem[] | null {
  const payload = record(value);
  const rawItems = Array.isArray(value) ? value : payload?.todos;
  if (!Array.isArray(rawItems)) return null;
  const items = rawItems.flatMap((entry, index) => {
    const item = toTaskItem(entry, index);
    return item ? [item] : [];
  });
  return items;
}

export function isAcpTodoMerge(value: unknown): boolean {
  return record(value)?.merge === true;
}

export function isAcpTodoToolInput(rawInput: unknown, title?: string | null): boolean {
  const input = record(rawInput);
  if (!input) return false;
  const toolName = string(input._toolName) ?? string(input.toolName);
  if (toolName && TODO_TOOL_NAMES.has(normalizeName(toolName))) return true;
  if (title && /^update todos\b/i.test(title.trim())) return true;
  const items = parseAcpTodoItems(input);
  return items !== null && items.length > 0;
}

export function mapPlanEntriesToTodo(
  entries: Array<{ content: string; status: "pending" | "in_progress" | "completed" }>,
): TodoSnapshot {
  return {
    type: "todo",
    items: entries.map((entry, index) => ({
      id: String(index),
      text: entry.content,
      status: entry.status,
      completed: entry.status === "completed",
    })),
  };
}

/** Accumulates ACP plan updates and Cursor-style todo tool payloads into canonical snapshots. */
export class AcpTaskState {
  private readonly tasks = new Map<string, AgentTaskItem>();

  replace(items: AgentTaskItem[]): TodoSnapshot {
    this.tasks.clear();
    for (const [index, item] of items.entries()) {
      const id = item.id ?? String(index);
      this.tasks.set(id, { ...item, id });
    }
    return this.snapshot();
  }

  merge(items: AgentTaskItem[]): TodoSnapshot {
    for (const item of items) {
      const id = item.id;
      if (!id) continue;
      const current = this.tasks.get(id);
      this.tasks.set(id, { ...current, ...item, id });
    }
    return this.snapshot();
  }

  apply(items: AgentTaskItem[], merge: boolean): TodoSnapshot {
    return merge ? this.merge(items) : this.replace(items);
  }

  private snapshot(): TodoSnapshot {
    return { type: "todo", items: [...this.tasks.values()] };
  }
}
