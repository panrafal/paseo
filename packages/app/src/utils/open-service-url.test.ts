import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceUrlBehavior } from "@/hooks/use-settings";

const state = vi.hoisted(() => ({
  behavior: "external" as ServiceUrlBehavior,
  openExternalUrl: vi.fn(async (_url: string) => undefined),
  askWithCheckbox: vi.fn(async () => ({ confirmed: true, dontAskAgain: false })),
}));

vi.mock("@/desktop/host", () => ({
  isElectronRuntime: () => true,
  getDesktopHost: () => ({ dialog: { askWithCheckbox: state.askWithCheckbox } }),
}));

vi.mock("@/hooks/use-settings", () => ({
  loadAppSettingsFromStorage: async () => ({ serviceUrlBehavior: state.behavior }),
  persistAppSettings: async () => undefined,
}));

vi.mock("@/i18n/i18next", () => ({
  i18n: { t: (key: string) => key },
}));

vi.mock("@/utils/open-external-url", () => ({
  openExternalUrl: state.openExternalUrl,
}));

import { openServiceUrl } from "./open-service-url";

const URL = "https://example.com/";

describe("openServiceUrl", () => {
  beforeEach(() => {
    state.openExternalUrl.mockClear();
    state.askWithCheckbox.mockClear();
  });

  it.each([
    { behavior: "in-app", invertBehavior: false, opensInApp: true },
    { behavior: "in-app", invertBehavior: true, opensInApp: false },
    { behavior: "external", invertBehavior: false, opensInApp: false },
    { behavior: "external", invertBehavior: true, opensInApp: true },
  ] as const)(
    "setting=$behavior invert=$invertBehavior opens in app: $opensInApp",
    async ({ behavior, invertBehavior, opensInApp }) => {
      state.behavior = behavior;
      const openInApp = vi.fn();

      await openServiceUrl(URL, { openInApp, invertBehavior });

      expect(openInApp).toHaveBeenCalledTimes(opensInApp ? 1 : 0);
      expect(state.openExternalUrl).toHaveBeenCalledTimes(opensInApp ? 0 : 1);
    },
  );

  it("still asks when the setting is Ask, even when inverted", async () => {
    state.behavior = "ask";
    const openInApp = vi.fn();

    await openServiceUrl(URL, { openInApp, invertBehavior: true });

    expect(state.askWithCheckbox).toHaveBeenCalledTimes(1);
    expect(openInApp).toHaveBeenCalledWith(URL);
  });
});
