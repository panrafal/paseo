import type { NotificationBehavior, NotificationContent } from "expo-notifications";

export function foregroundNotificationBehavior(
  data: NotificationContent["data"],
): NotificationBehavior {
  const notify = data.reason === "notify";
  return {
    shouldShowAlert: notify,
    shouldShowBanner: notify,
    shouldShowList: notify,
    // Android suppresses heads-up alerts when sound is disabled here.
    shouldPlaySound: notify,
    shouldSetBadge: false,
  };
}
