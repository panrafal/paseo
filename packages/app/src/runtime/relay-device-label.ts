import { Platform } from "react-native";
import { getIsElectron, isWeb } from "@/constants/platform";

/** Shown in the host's paired-device list so an owner can tell their devices apart. */
export function relayDeviceLabel(appVersion: string | null): string {
  const surface = describeSurface();
  return appVersion ? `Paseo ${surface} ${appVersion}` : `Paseo ${surface}`;
}

function describeSurface(): string {
  if (getIsElectron()) return "desktop";
  if (isWeb) return "web";
  return Platform.OS === "ios" ? "iOS" : "Android";
}
