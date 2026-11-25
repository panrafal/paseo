import { useCallback } from "react";
import { useNavigationContainerRef, usePathname } from "expo-router";
import { useApplicationRouteHistory } from "./route-history-shared";
import { buildNativeRouteHistoryHref } from "./route-history-native-href";
export type { RouteHistoryDirection } from "./route-history-state";

export function useRouteHistory() {
  const pathname = usePathname();
  const navigation = useNavigationContainerRef();
  const readHref = useCallback(() => {
    const focusedRoute = navigation.getCurrentRoute() as { params?: object } | undefined;
    return buildNativeRouteHistoryHref(pathname, focusedRoute?.params);
  }, [pathname, navigation]);
  return useApplicationRouteHistory(readHref);
}
