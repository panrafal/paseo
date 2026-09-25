import type { AgentProfile } from "@getpaseo/protocol/messages";

export interface CreateAgentLaunchSettings {
  modeId?: string;
  thinkingOptionId?: string;
  features?: Record<string, unknown>;
}

/**
 * Orchestrators copy provider/model/mode/thinking from list_profiles and drop
 * nested featureValues, so Cursor Auto Accept never reaches create_agent.
 * Fill omitted settings only when exactly one configured profile matches.
 */
export function mergeOmittedCreateAgentSettingsFromUniqueProfile(input: {
  profiles: readonly AgentProfile[];
  provider: string;
  model: string | undefined;
  settings: CreateAgentLaunchSettings | undefined;
}): CreateAgentLaunchSettings | undefined {
  const matched = findUniqueMatchingAgentProfile(input);
  if (!matched) {
    return input.settings;
  }

  const modeId = input.settings?.modeId ?? trimmed(matched.modeId);
  const thinkingOptionId = input.settings?.thinkingOptionId ?? trimmed(matched.thinkingOptionId);
  const features = input.settings?.features ?? matched.featureValues;
  return compactLaunchSettings({ modeId, thinkingOptionId, features });
}

function findUniqueMatchingAgentProfile(input: {
  profiles: readonly AgentProfile[];
  provider: string;
  model: string | undefined;
  settings: CreateAgentLaunchSettings | undefined;
}): AgentProfile | undefined {
  const matches = input.profiles.filter((candidate) =>
    profileMatchesLaunch(candidate, input.provider, input.model, input.settings),
  );
  if (matches.length !== 1) {
    return undefined;
  }
  return matches[0];
}

function profileMatchesLaunch(
  profile: AgentProfile,
  provider: string,
  model: string | undefined,
  settings: CreateAgentLaunchSettings | undefined,
): boolean {
  if (profile.provider !== provider) {
    return false;
  }
  const profileModel = trimmed(profile.model);
  if (profileModel && profileModel !== model) {
    return false;
  }
  const profileModeId = trimmed(profile.modeId);
  const requestedModeId = settings?.modeId;
  if (requestedModeId && profileModeId && profileModeId !== requestedModeId) {
    return false;
  }
  const profileThinkingOptionId = trimmed(profile.thinkingOptionId);
  const requestedThinkingOptionId = settings?.thinkingOptionId;
  if (
    requestedThinkingOptionId &&
    profileThinkingOptionId &&
    profileThinkingOptionId !== requestedThinkingOptionId
  ) {
    return false;
  }
  return true;
}

function compactLaunchSettings(settings: {
  modeId: string | undefined;
  thinkingOptionId: string | undefined;
  features: Record<string, unknown> | undefined;
}): CreateAgentLaunchSettings | undefined {
  const next: CreateAgentLaunchSettings = {};
  if (settings.modeId) {
    next.modeId = settings.modeId;
  }
  if (settings.thinkingOptionId) {
    next.thinkingOptionId = settings.thinkingOptionId;
  }
  if (settings.features) {
    next.features = settings.features;
  }
  if (Object.keys(next).length === 0) {
    return undefined;
  }
  return next;
}

function trimmed(value: string | undefined): string | undefined {
  const next = value?.trim();
  return next ? next : undefined;
}
