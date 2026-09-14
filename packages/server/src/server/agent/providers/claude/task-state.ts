import type { AgentTaskItem, AgentTimelineItem } from "../../agent-sdk-types.js";

type TaskToolName = "TodoWrite" | "TaskCreate" | "TaskUpdate" | "TaskList";

interface PendingTaskTool {
  name: TaskToolName;
  input: Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function taskStatus(value: unknown): AgentTaskItem["status"] | "deleted" {
  if (value === "completed" || value === "deleted" || value === "in_progress") return value;
  return "pending";
}

function retainedTaskStatus(task: AgentTaskItem): AgentTaskItem["status"] {
  if (task.status) return task.status;
  return task.completed ? "completed" : "pending";
}

function toTaskItem(value: unknown): AgentTaskItem | null {
  const task = record(value);
  if (!task) return null;
  const text = string(task.subject) ?? string(task.content) ?? string(task.text);
  if (!text) return null;
  const status = taskStatus(task.status);
  if (status === "deleted") return null;
  const id = string(task.id) ?? string(task.taskId);
  const activeForm = string(task.activeForm) ?? string(task.active_form);
  return {
    ...(id ? { id } : {}),
    text,
    status,
    completed: status === "completed",
    ...(activeForm ? { activeForm } : {}),
  };
}

function toolUses(message: Record<string, unknown>): Array<Record<string, unknown>> {
  const content = record(message.message)?.content;
  return Array.isArray(content)
    ? content.flatMap((block) => {
        const candidate = record(block);
        return candidate?.type === "tool_use" ? [candidate] : [];
      })
    : [];
}

function toolResultId(message: Record<string, unknown>): string | undefined {
  const content = record(message.message)?.content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    const candidate = record(block);
    if (candidate?.type === "tool_result") return string(candidate.tool_use_id);
  }
  return undefined;
}

function structuredResult(message: Record<string, unknown>): Record<string, unknown> | null {
  return (
    record(message.toolUseResult) ??
    record(message.tool_use_result) ??
    parseToolResultPayload(message)
  );
}

function parseToolResultPayload(message: Record<string, unknown>): Record<string, unknown> | null {
  const content = record(message.message)?.content;
  if (!Array.isArray(content)) return parseResultValue(content);
  for (const block of content) {
    const candidate = record(block);
    if (candidate?.type !== "tool_result") continue;
    const parsed = parseResultValue(candidate.content);
    if (parsed) return parsed;
  }
  return null;
}

function parseResultValue(value: unknown): Record<string, unknown> | null {
  const asRecord = record(value);
  if (asRecord?.task || asRecord?.tasks || asRecord?.taskId || asRecord?.statusChange) {
    return asRecord;
  }
  if (typeof value === "string") {
    try {
      return record(JSON.parse(value));
    } catch {
      return null;
    }
  }
  if (!Array.isArray(value)) return null;
  const text = value
    .flatMap((block) => {
      const candidate = record(block);
      return candidate?.type === "text" && typeof candidate.text === "string"
        ? [candidate.text]
        : [];
    })
    .join("");
  if (!text) return null;
  try {
    return record(JSON.parse(text));
  } catch {
    return null;
  }
}

function toolResultIsError(message: Record<string, unknown>): boolean {
  const content = record(message.message)?.content;
  if (!Array.isArray(content)) return false;
  for (const block of content) {
    const candidate = record(block);
    if (candidate?.type === "tool_result" && candidate.is_error === true) return true;
  }
  return false;
}

/** Accumulates Claude's snapshot and ID-based task tools into canonical todo snapshots. */
export class ClaudeTaskState {
  private readonly tasks = new Map<string, AgentTaskItem>();
  private readonly calls = new Map<string, PendingTaskTool>();
  private readonly appliedResults = new Set<string>();
  private readonly aliases = new Map<string, string>();

  observe(value: unknown): Extract<AgentTimelineItem, { type: "todo" }> | null {
    const message = record(value);
    if (!message) return null;

    let snapshot: Extract<AgentTimelineItem, { type: "todo" }> | null = null;
    for (const block of toolUses(message)) {
      const id = string(block.id);
      const name = string(block.name);
      if (!id || !isTaskToolName(name)) continue;
      const input = record(block.input) ?? {};
      this.calls.set(id, { name, input });
      if (name === "TodoWrite") snapshot = this.replaceLegacyTodos(input.todos);
      if (name === "TaskCreate") snapshot = this.applyCreate(input, null, id);
      if (name === "TaskUpdate") snapshot = this.applyUpdate(input, null);
    }

    const resultId = toolResultId(message);
    if (!resultId || this.appliedResults.has(resultId)) return snapshot;
    const call = this.calls.get(resultId);
    if (!call) return snapshot;
    this.appliedResults.add(resultId);
    this.calls.delete(resultId);
    const result = structuredResult(message);
    if (toolResultIsError(message) || result?.success === false) {
      return this.applyFailure(call, resultId) ?? snapshot;
    }
    return this.applyResult(call, result, resultId) ?? snapshot;
  }

  reset(): void {
    this.tasks.clear();
    this.calls.clear();
    this.appliedResults.clear();
    this.aliases.clear();
  }

  private storedId(id: string): string {
    return this.aliases.get(id) ?? id;
  }

  private rememberAlias(realId: string | undefined, storedId: string): void {
    if (realId && realId !== storedId) {
      this.aliases.set(realId, storedId);
    }
  }

  private forgetStoredId(storedId: string): void {
    for (const [realId, alias] of this.aliases) {
      if (alias === storedId) this.aliases.delete(realId);
    }
  }

  private replaceLegacyTodos(value: unknown): Extract<AgentTimelineItem, { type: "todo" }> {
    this.tasks.clear();
    this.aliases.clear();
    if (Array.isArray(value)) {
      for (const [index, taskValue] of value.entries()) {
        const item = toTaskItem(taskValue);
        if (!item) continue;
        const id = item.id ?? `legacy:${index}`;
        this.tasks.set(id, { ...item, id });
      }
    }
    return this.snapshot();
  }

  private applyFailure(
    call: PendingTaskTool,
    pendingId: string,
  ): Extract<AgentTimelineItem, { type: "todo" }> | null {
    if (call.name !== "TaskCreate") return null;
    this.tasks.delete(pendingId);
    this.forgetStoredId(pendingId);
    return this.snapshot();
  }

  private applyResult(
    call: PendingTaskTool,
    result: Record<string, unknown> | null,
    pendingId: string,
  ): Extract<AgentTimelineItem, { type: "todo" }> | null {
    if (call.name === "TaskCreate") return this.applyCreate(call.input, result, pendingId);
    if (call.name === "TaskUpdate") return this.applyUpdate(call.input, result);
    if (call.name === "TaskList") return this.applyList(result);
    return null;
  }

  private applyCreate(
    input: Record<string, unknown>,
    result: Record<string, unknown> | null,
    pendingId?: string,
  ): Extract<AgentTimelineItem, { type: "todo" }> | null {
    const resultTask = record(result?.task);
    const realId = string(resultTask?.id) ?? string(result?.taskId) ?? string(input.taskId);
    const id = pendingId ?? (realId ? this.storedId(realId) : undefined) ?? realId;
    const text = string(resultTask?.subject) ?? string(input.subject);
    if (!id || !text) return null;
    this.rememberAlias(realId, id);
    const activeForm = string(input.activeForm);
    this.tasks.set(id, {
      id,
      text,
      status: "pending",
      completed: false,
      ...(activeForm ? { activeForm } : {}),
    });
    return this.snapshot();
  }

  private applyUpdate(
    input: Record<string, unknown>,
    result: Record<string, unknown> | null,
  ): Extract<AgentTimelineItem, { type: "todo" }> | null {
    const requestedId = string(input.taskId) ?? string(result?.taskId);
    if (!requestedId) return null;
    const id = this.storedId(requestedId);
    const current = this.tasks.get(id);
    const statusValue = input.status ?? record(result?.statusChange)?.to;
    if (!current) {
      return statusValue !== undefined && taskStatus(statusValue) === "deleted"
        ? this.snapshot()
        : null;
    }
    const status =
      statusValue === undefined ? retainedTaskStatus(current) : taskStatus(statusValue);
    if (status === "deleted") {
      this.tasks.delete(id);
      this.forgetStoredId(id);
      return this.snapshot();
    }
    const text = string(input.subject);
    const activeForm = string(input.activeForm);
    this.tasks.set(id, {
      ...current,
      ...(text ? { text } : {}),
      ...(activeForm ? { activeForm } : {}),
      status,
      completed: status === "completed",
    });
    return this.snapshot();
  }

  private applyList(
    result: Record<string, unknown> | null,
  ): Extract<AgentTimelineItem, { type: "todo" }> | null {
    const tasks = result?.tasks;
    if (!Array.isArray(tasks)) return null;
    const next = new Map<string, AgentTaskItem>();
    const nextAliases = new Map<string, string>();
    for (const taskValue of tasks) {
      const item = toTaskItem(taskValue);
      if (!item?.id) continue;
      const id = this.storedId(item.id);
      if (id !== item.id) nextAliases.set(item.id, id);
      next.set(id, { ...item, id });
    }
    this.tasks.clear();
    this.aliases.clear();
    for (const [id, item] of next) this.tasks.set(id, item);
    for (const [realId, storedId] of nextAliases) this.aliases.set(realId, storedId);
    return this.snapshot();
  }

  private snapshot(): Extract<AgentTimelineItem, { type: "todo" }> {
    return { type: "todo", items: [...this.tasks.values()] };
  }
}

function isTaskToolName(value: string | undefined): value is TaskToolName {
  return (
    value === "TodoWrite" ||
    value === "TaskCreate" ||
    value === "TaskUpdate" ||
    value === "TaskList"
  );
}
