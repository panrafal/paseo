import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveNotifyOptions } from "./notify.js";
import { renderError, toCommandError } from "../output/index.js";

afterEach(() => vi.unstubAllEnvs());

function renderNotifyInputError(message: string, title?: string): string {
  try {
    resolveNotifyOptions(message, { agent: "agent-1", title });
  } catch (error) {
    return renderError(toCommandError(error), { noColor: true });
  }
  throw new Error("Expected invalid notify input");
}

describe("notify options", () => {
  it("uses the injected agent ID and preserves the message", () => {
    vi.stubEnv("PASEO_AGENT_ID", " env-agent ");
    expect(resolveNotifyOptions("Build failed\nPlease review", {})).toEqual({
      agentId: "env-agent",
      message: "Build failed\nPlease review",
      title: undefined,
      urgent: undefined,
    });
  });

  it("lets the explicit agent override the environment", () => {
    vi.stubEnv("PASEO_AGENT_ID", "env-agent");
    expect(
      resolveNotifyOptions("Review needed", {
        agent: "flag-agent",
        title: "Maintenance",
        urgent: true,
      }),
    ).toEqual({
      agentId: "flag-agent",
      message: "Review needed",
      title: "Maintenance",
      urgent: true,
    });
  });

  it("works outside an agent with an explicit ID", () => {
    vi.stubEnv("PASEO_AGENT_ID", undefined);
    expect(resolveNotifyOptions("Done", { agent: "flag-agent" }).agentId).toBe("flag-agent");
  });

  it.each([undefined, "", "   "])("rejects a missing caller ID (%s)", (agentId) => {
    vi.stubEnv("PASEO_AGENT_ID", agentId);
    expect(() => resolveNotifyOptions("Done", {})).toThrow(
      "Set PASEO_AGENT_ID or pass --agent <id> to send a notification",
    );
  });

  it("rejects an empty explicit override instead of falling back to the environment", () => {
    vi.stubEnv("PASEO_AGENT_ID", "env-agent");
    expect(() => resolveNotifyOptions("Done", { agent: " " })).toThrow("pass --agent <id>");
  });

  it.each(["", " \n "])("rejects an empty message with a one-line error (%j)", (message) => {
    expect(renderNotifyInputError(message)).toBe("Error: Notification message must not be empty");
  });

  it.each(["", " \n "])("rejects an empty title with a one-line error (%j)", (title) => {
    expect(renderNotifyInputError("Done", title)).toBe(
      "Error: Notification title must not be empty",
    );
  });
});
