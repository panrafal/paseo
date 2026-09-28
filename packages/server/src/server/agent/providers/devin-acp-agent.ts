import type { Logger } from "pino";

import type { ACPSlashCommandKindResolver } from "./acp-agent.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";

interface DevinACPAgentClientOptions {
  logger: Logger;
  command: [string, ...string[]];
  env?: Record<string, string>;
  providerId?: string;
  label?: string;
  providerParams?: unknown;
}

// Devin CLI tags its skills with `_meta["cognition.ai/category"] === "Skills"` in
// the standard `available_commands_update` session update; built-in slash
// commands carry other categories ("Session", "Account", "System").
const DEVIN_SKILL_CATEGORY = "Skills";

export const resolveDevinSlashCommandKind: ACPSlashCommandKindResolver = (command) =>
  command._meta?.["cognition.ai/category"] === DEVIN_SKILL_CATEGORY ? "skill" : "command";

export class DevinACPAgentClient extends GenericACPAgentClient {
  constructor(options: DevinACPAgentClientOptions) {
    super({
      logger: options.logger,
      command: options.command,
      env: options.env,
      providerId: options.providerId,
      label: options.label,
      providerParams: options.providerParams,
      slashCommandKindResolver: resolveDevinSlashCommandKind,
    });
  }
}
