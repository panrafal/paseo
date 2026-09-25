import { getDesktopHost, isElectronRuntime } from "@/desktop/host";
import {
  loadAppSettingsFromStorage,
  persistAppSettings,
  type ServiceUrlBehavior,
} from "@/hooks/use-settings";
import { i18n } from "@/i18n/i18next";
import { openExternalUrl } from "@/utils/open-external-url";

export interface OpenServiceUrlOptions {
  openInApp?: (url: string) => void;
  // Swaps a saved "In Paseo" / "External browser" choice for this one URL. "Ask" still asks.
  invertBehavior?: boolean;
}

export async function openServiceUrl(url: string, options?: OpenServiceUrlOptions): Promise<void> {
  const openInApp = options?.openInApp;
  if (!openInApp || !isElectronRuntime()) {
    await openExternalUrl(url);
    return;
  }

  const behavior = await resolveBehavior(url, options?.invertBehavior === true);
  if (behavior === "in-app") {
    openInApp(url);
    return;
  }
  await openExternalUrl(url);
}

async function resolveBehavior(
  url: string,
  invert: boolean,
): Promise<Exclude<ServiceUrlBehavior, "ask">> {
  const settings = await loadAppSettingsFromStorage();
  if (settings.serviceUrlBehavior === "in-app") {
    return invert ? "external" : "in-app";
  }
  if (settings.serviceUrlBehavior === "external") {
    return invert ? "in-app" : "external";
  }

  const askWithCheckbox = getDesktopHost()?.dialog?.askWithCheckbox;
  if (typeof askWithCheckbox !== "function") {
    return "external";
  }

  const result = await askWithCheckbox(i18n.t("serviceUrl.message", { url }), {
    title: i18n.t("serviceUrl.title"),
    okLabel: i18n.t("serviceUrl.inPaseo"),
    cancelLabel: i18n.t("serviceUrl.externalBrowser"),
    checkboxLabel: i18n.t("serviceUrl.dontAskAgain"),
  });

  const choice: Exclude<ServiceUrlBehavior, "ask"> = result.confirmed ? "in-app" : "external";
  if (result.dontAskAgain) {
    await persistAppSettings({ serviceUrlBehavior: choice });
  }
  return choice;
}
