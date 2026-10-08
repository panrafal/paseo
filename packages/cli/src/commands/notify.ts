import { Command } from "commander";
import type { NotifyOptions } from "@getpaseo/protocol/notify";
import {
  withOutput,
  type CommandError,
  type CommandOptions,
  type SingleResult,
} from "../output/index.js";
import { addJsonAndDaemonHostOptions } from "../utils/command-options.js";
import { connectToDaemon } from "../utils/client.js";

interface NotifyCommandOptions extends CommandOptions {
  agent?: string;
  title?: string;
  urgent?: boolean;
}

interface NotifyResult {
  agentId: string;
  status: "accepted";
}

export function resolveNotifyOptions(
  message: string,
  options: Pick<NotifyCommandOptions, "agent" | "title" | "urgent">,
): NotifyOptions {
  const agentId = (options.agent ?? process.env.PASEO_AGENT_ID)?.trim();
  if (!agentId) throw new Error("Set PASEO_AGENT_ID or pass --agent <id> to send a notification");
  if (!message.trim())
    throw {
      code: "INVALID_NOTIFY_INPUT",
      message: "Notification message must not be empty",
    } satisfies CommandError;
  if (options.title !== undefined && !options.title.trim())
    throw {
      code: "INVALID_NOTIFY_INPUT",
      message: "Notification title must not be empty",
    } satisfies CommandError;
  return {
    agentId,
    message,
    title: options.title,
    urgent: options.urgent,
  };
}

export async function runNotifyCommand(
  message: string,
  options: NotifyCommandOptions,
  _command: Command,
): Promise<SingleResult<NotifyResult>> {
  const input = resolveNotifyOptions(message, options);
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    const response = await client.notify(input);
    if (response.error) throw new Error(response.error);
    return {
      type: "single",
      data: { agentId: response.agentId, status: "accepted" },
      schema: {
        idField: "agentId",
        columns: [
          { header: "AGENT", field: "agentId" },
          { header: "STATUS", field: "status" },
        ],
      },
    };
  } finally {
    await client.close();
  }
}

export function createNotifyCommand(): Command {
  return addJsonAndDaemonHostOptions(
    new Command("notify")
      .description("Send a notification that opens an agent")
      .argument("<message>", "Notification body")
      .option("--title <title>", "Notification title (defaults to the agent title)")
      .option("--urgent", "Always push to the phone, even while a client is active")
      .option("--agent <id>", "Agent ID (defaults to PASEO_AGENT_ID)"),
  ).action(withOutput(runNotifyCommand));
}
