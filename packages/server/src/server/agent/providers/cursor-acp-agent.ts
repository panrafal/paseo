import { zSessionConfigOption } from "@agentclientprotocol/sdk/dist/schema/zod.gen.js";
import type { Logger } from "pino";
import { z } from "zod";

import type { AgentModelDefinition, AgentSelectOption } from "../agent-sdk-types.js";
import { withTimeout } from "../../../utils/promise-timeout.js";
import {
  deriveSelectorOptions,
  findSelectConfigOption,
  type ACPCatalogModelResolverContext,
  type ACPConfigFeatureOption,
} from "./acp-agent.js";
import { toDiagnosticErrorMessage } from "./diagnostic-utils.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";

interface CursorACPAgentClientOptions {
  logger: Logger;
  command: [string, ...string[]];
  env?: Record<string, string>;
  providerId?: string;
  label?: string;
  providerParams?: unknown;
  now?: () => number;
  catalogProbeBudgetMs?: number;
  catalogProbePerModelTimeoutMs?: number;
  thinkingCache?: CursorThinkingCache;
  thinkingCacheTtlMs?: number;
}

const CURSOR_INITIAL_COMMANDS_WAIT_TIMEOUT_MS = 10_000;
const CURSOR_CLIENT_CAPABILITY_META = {
  parameterizedModelPicker: true,
};

// Cursor's ACP catalog is large, and a single model switch can hang. MCP
// create_agent waits for a ready provider snapshot, so probing every model
// until the 120s refresh deadline makes Cursor unusable from MCP. Probe
// unknown models inside this budget, then reuse the result for a day.
const CURSOR_CATALOG_PROBE_BUDGET_MS = 15_000;
const CURSOR_CATALOG_PROBE_PER_MODEL_TIMEOUT_MS = 2_500;
const CURSOR_THINKING_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export const CURSOR_FAST_FEATURE_OPTION: ACPConfigFeatureOption = {
  id: "fast",
  configId: "fast",
  label: "Fast",
  description: "Cursor fast mode",
  tooltip: "Select Cursor fast mode",
  icon: "zap",
};

const CursorModelCatalogSchema = z.object({
  models: z.array(
    z.object({
      value: z.string().min(1),
      name: z.string(),
      configOptions: z.array(zSessionConfigOption),
    }),
  ),
});

// Cursor model switches persist CLI preferences, even in a throwaway probe session.
// Its extension returns each model's parameter definitions without selecting it.
async function resolveCursorCatalogModelsFromExtension({
  connection,
  models,
  provider,
  runRequest,
}: ACPCatalogModelResolverContext): Promise<AgentModelDefinition[]> {
  const catalog = await runRequest(() => fetchCursorModelCatalog(connection));
  const currentModelId = models.find((model) => model.isDefault)?.id;

  return catalog.models.map((model) => {
    const thinkingOptions = deriveSelectorOptions(model.configOptions, "thought_level");
    const defaultThinkingOptionId = thinkingOptions.find((option) => option.isDefault)?.id;
    return {
      provider,
      id: model.value,
      label: model.name,
      isDefault: model.value === currentModelId,
      thinkingOptions: thinkingOptions.length > 0 ? thinkingOptions : undefined,
      defaultThinkingOptionId,
    };
  });
}

async function fetchCursorModelCatalog(connection: ACPCatalogModelResolverContext["connection"]) {
  try {
    const response = await connection.extMethod("cursor/list_available_models", {});
    return CursorModelCatalogSchema.parse(response);
  } catch (error) {
    const extensionUnavailable =
      typeof error === "object" && error !== null && "code" in error && error.code === -32601;
    if (extensionUnavailable) {
      throw new Error(
        "Update Cursor CLI: this version does not support cursor/list_available_models.",
        { cause: error },
      );
    }
    throw error;
  }
}

interface CursorCachedThinking {
  thinkingOptions: AgentSelectOption[] | undefined;
  defaultThinkingOptionId: string | undefined;
  cachedAtMs: number;
}

export type CursorThinkingCache = Map<string, CursorCachedThinking>;

interface CursorCatalogProbeLimits {
  now?: () => number;
  budgetMs?: number;
  perModelTimeoutMs?: number;
  cache?: CursorThinkingCache;
  cacheTtlMs?: number;
}

function thinkingFromModel(model: AgentModelDefinition, cachedAtMs: number): CursorCachedThinking {
  return {
    thinkingOptions: model.thinkingOptions,
    defaultThinkingOptionId: model.defaultThinkingOptionId,
    cachedAtMs,
  };
}

function applyCachedThinking(
  model: AgentModelDefinition,
  cached: CursorCachedThinking,
): AgentModelDefinition {
  return {
    ...model,
    thinkingOptions: cached.thinkingOptions,
    defaultThinkingOptionId: cached.defaultThinkingOptionId,
  };
}

function withoutThinking(model: AgentModelDefinition): AgentModelDefinition {
  return {
    ...model,
    thinkingOptions: undefined,
    defaultThinkingOptionId: undefined,
  };
}

function readFreshCache(
  cache: CursorThinkingCache,
  modelId: string,
  nowMs: number,
  ttlMs: number,
): CursorCachedThinking | undefined {
  const cached = cache.get(modelId);
  if (!cached) {
    return undefined;
  }
  if (nowMs - cached.cachedAtMs >= ttlMs) {
    cache.delete(modelId);
    return undefined;
  }
  return cached;
}

function isCursorCatalogProbeTimeout(error: unknown, modelId: string): boolean {
  return error instanceof Error && error.message.includes(`Cursor catalog probe for "${modelId}"`);
}

/**
 * Cursor reports different thinking levels per model, but only exposes the currently
 * selected model's levels through `configOptions`. Switching a candidate is how we
 * learn Grok's effort options without stamping Composer's empty list — or Haiku's
 * Off/On — onto the rest of the catalog.
 *
 * Probe results are reused for a day so later refreshes and other workspaces do not
 * wait on Cursor again. Unprobed models stay uncached so a later refresh can keep
 * filling the map. A switch that times out is remembered as "no thinking" until the
 * cache expires, so MCP create_agent does not wait on it again that day.
 */
async function resolveCursorCatalogModelsWithProbes(
  {
    connection,
    sessionId,
    models,
    configOptions,
    runRequest,
    transformConfigOptions,
    logger,
    provider,
  }: ACPCatalogModelResolverContext,
  limits: CursorCatalogProbeLimits = {},
): Promise<AgentModelDefinition[]> {
  if (models.length <= 1) {
    return models;
  }
  const modelOption = findSelectConfigOption({ configOptions, category: "model" });
  if (!modelOption) {
    return models;
  }

  const cache = limits.cache ?? new Map();
  const now = limits.now ?? Date.now;
  const budgetMs = limits.budgetMs ?? CURSOR_CATALOG_PROBE_BUDGET_MS;
  const perModelTimeoutMs = limits.perModelTimeoutMs ?? CURSOR_CATALOG_PROBE_PER_MODEL_TIMEOUT_MS;
  const cacheTtlMs = limits.cacheTtlMs ?? CURSOR_THINKING_CACHE_TTL_MS;
  const deadlineMs = now() + budgetMs;
  const resolved: AgentModelDefinition[] = [];
  let stopProbing = false;

  for (const model of models) {
    const cached = readFreshCache(cache, model.id, now(), cacheTtlMs);
    if (cached) {
      resolved.push(applyCachedThinking(model, cached));
      continue;
    }

    if (model.isDefault) {
      cache.set(model.id, thinkingFromModel(model, now()));
      resolved.push(model);
      continue;
    }

    const remainingMs = deadlineMs - now();
    if (stopProbing || remainingMs <= 0) {
      resolved.push(withoutThinking(model));
      continue;
    }

    const timeoutMs = Math.min(perModelTimeoutMs, remainingMs);
    try {
      const response = await withTimeout(
        runRequest(() =>
          connection.setSessionConfigOption({
            sessionId,
            configId: modelOption.id,
            value: model.id,
          }),
        ),
        timeoutMs,
        `Cursor catalog probe for "${model.id}" timed out after ${timeoutMs}ms`,
      );
      const modelConfigOptions = transformConfigOptions(response.configOptions ?? []);
      const thinkingOptions = deriveSelectorOptions(modelConfigOptions, "thought_level");
      const probed: CursorCachedThinking = {
        thinkingOptions: thinkingOptions.length > 0 ? thinkingOptions : undefined,
        defaultThinkingOptionId:
          thinkingOptions.find((option) => option.isDefault)?.id ?? undefined,
        cachedAtMs: now(),
      };
      cache.set(model.id, probed);
      resolved.push(applyCachedThinking(model, probed));
    } catch (error) {
      if (isCursorCatalogProbeTimeout(error, model.id)) {
        stopProbing = true;
      }
      const errorMessage = toDiagnosticErrorMessage(error);
      logger.warn(
        { modelId: model.id, error: errorMessage },
        `${provider} catalog probe could not resolve thinking options for model "${model.id}"; omitting thinking options`,
      );
      const omitted = thinkingFromModel(withoutThinking(model), now());
      cache.set(model.id, omitted);
      resolved.push(withoutThinking(model));
    }
  }
  return resolved;
}

export async function resolveCursorCatalogModels(
  context: ACPCatalogModelResolverContext,
  limits: CursorCatalogProbeLimits = {},
): Promise<AgentModelDefinition[]> {
  // Prefer Cursor's catalog extension because it returns model-specific options
  // without changing the user's preferences. Keep bounded probing for legacy
  // ACP connections that predate the catalog extension.
  if (typeof context.connection.extMethod === "function") {
    return resolveCursorCatalogModelsFromExtension(context);
  }
  return resolveCursorCatalogModelsWithProbes(context, limits);
}

export class CursorACPAgentClient extends GenericACPAgentClient {
  constructor(options: CursorACPAgentClientOptions) {
    const thinkingCache = options.thinkingCache ?? new Map();
    super({
      logger: options.logger,
      command: options.command,
      env: options.env,
      providerId: options.providerId,
      label: options.label,
      providerParams: options.providerParams,
      now: options.now,
      // cursor-agent publishes slash commands asynchronously via available_commands_update.
      waitForInitialCommands: true,
      initialCommandsWaitTimeoutMs: CURSOR_INITIAL_COMMANDS_WAIT_TIMEOUT_MS,
      clientCapabilityMeta: CURSOR_CLIENT_CAPABILITY_META,
      configFeatureOptions: [CURSOR_FAST_FEATURE_OPTION],
      catalogModelResolver: (context) =>
        resolveCursorCatalogModels(context, {
          now: options.now,
          budgetMs: options.catalogProbeBudgetMs,
          perModelTimeoutMs: options.catalogProbePerModelTimeoutMs,
          cache: thinkingCache,
          cacheTtlMs: options.thinkingCacheTtlMs,
        }),
    });
  }

  async getCatalogCacheKey(): Promise<string> {
    // Cursor's model and thinking catalog is host-level, independent of project cwd.
    return "host";
  }
}
