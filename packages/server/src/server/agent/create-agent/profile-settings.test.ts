import { expect, test } from "vitest";
import type { AgentProfile } from "@getpaseo/protocol/messages";

import { mergeOmittedCreateAgentSettingsFromUniqueProfile } from "./profile-settings.js";

function profile(
  overrides: Partial<AgentProfile> & Pick<AgentProfile, "id" | "name" | "provider">,
): AgentProfile {
  return {
    ...overrides,
  };
}

const cursorMedium: AgentProfile = profile({
  id: "profile_agent_medium_cursor",
  name: "Agent Medium · Cursor",
  provider: "cursor",
  model: "grok-4.6",
  modeId: "agent",
  thinkingOptionId: "high",
  featureValues: { auto_accept: true },
});

const cursorReader: AgentProfile = profile({
  id: "profile_read_cursor",
  name: "Reader · Cursor",
  provider: "cursor",
  model: "grok-4.6",
  modeId: "agent",
  thinkingOptionId: "low",
  featureValues: { auto_accept: false, fast: "false" },
});

test("fills omitted Auto Accept from a uniquely matching profile", () => {
  expect(
    mergeOmittedCreateAgentSettingsFromUniqueProfile({
      profiles: [cursorMedium, cursorReader],
      provider: "cursor",
      model: "grok-4.6",
      settings: { modeId: "agent", thinkingOptionId: "high" },
    }),
  ).toEqual({
    modeId: "agent",
    thinkingOptionId: "high",
    features: { auto_accept: true },
  });
});

test("does not guess features when two profiles share provider, model, and mode", () => {
  expect(
    mergeOmittedCreateAgentSettingsFromUniqueProfile({
      profiles: [cursorMedium, cursorReader],
      provider: "cursor",
      model: "grok-4.6",
      settings: { modeId: "agent" },
    }),
  ).toEqual({ modeId: "agent" });
});

test("keeps explicit features instead of replacing them from the profile", () => {
  expect(
    mergeOmittedCreateAgentSettingsFromUniqueProfile({
      profiles: [cursorMedium],
      provider: "cursor",
      model: "grok-4.6",
      settings: {
        modeId: "agent",
        thinkingOptionId: "high",
        features: { auto_accept: false },
      },
    }),
  ).toEqual({
    modeId: "agent",
    thinkingOptionId: "high",
    features: { auto_accept: false },
  });
});

test("fills omitted mode and thinking when the profile is unique for provider and model", () => {
  expect(
    mergeOmittedCreateAgentSettingsFromUniqueProfile({
      profiles: [cursorMedium],
      provider: "cursor",
      model: "grok-4.6",
      settings: undefined,
    }),
  ).toEqual({
    modeId: "agent",
    thinkingOptionId: "high",
    features: { auto_accept: true },
  });
});
