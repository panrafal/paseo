import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Bookmark, BookmarkPlus, FilterX, RefreshCw } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { useSidebarPresets } from "@/components/sidebar/presets/model";
import { clearCommandCenterFocusRestoreElement } from "@/utils/command-center-focus-restore";
import type { CommandCenterContribution, CommandCenterIconProps } from "./contributions";
import { useCommandCenterActions } from "./provider";
import { buildSidebarPresetContributions } from "./root-contributions";

const mutedColor = (theme: { colors: { foregroundMuted: string } }) => ({
  color: theme.colors.foregroundMuted,
});
const ThemedBookmark = withUnistyles(Bookmark, mutedColor);
const ThemedBookmarkPlus = withUnistyles(BookmarkPlus, mutedColor);
const ThemedRefreshCw = withUnistyles(RefreshCw, mutedColor);
const ThemedFilterX = withUnistyles(FilterX, mutedColor);

function PresetIcon({ size }: CommandCenterIconProps) {
  return <ThemedBookmark size={size} strokeWidth={2.2} />;
}

function SaveIcon({ size }: CommandCenterIconProps) {
  return <ThemedBookmarkPlus size={size} strokeWidth={2.2} />;
}

function UpdateIcon({ size }: CommandCenterIconProps) {
  return <ThemedRefreshCw size={size} strokeWidth={2.2} />;
}

function ClearFiltersIcon({ size }: CommandCenterIconProps) {
  return <ThemedFilterX size={size} strokeWidth={2.2} />;
}

/**
 * Sidebar presets in the command center. A source of its own rather than part of the root actions,
 * because it follows every filter change and the root actions deliberately do not.
 */
export function CommandCenterSidebarPresetActions(): null {
  const { t } = useTranslation();
  const presets = useSidebarPresets();

  const actions = useMemo<CommandCenterContribution[]>(
    () =>
      buildSidebarPresetContributions({
        presets: presets.presets,
        activePresetId: presets.activePreset?.id ?? null,
        activePresetModified: presets.activePresetModified,
        hasActiveFilters: presets.hasActiveFilters,
        labels: {
          group: t("sidebar.presets.heading"),
          save: t("sidebar.presets.commandCenter.save"),
          update: (name) => t("sidebar.presets.commandCenter.update", { name }),
          clearFilters: t("sidebar.presets.commandCenter.clearFilters"),
        },
        icons: {
          preset: PresetIcon,
          save: SaveIcon,
          update: UpdateIcon,
          clearFilters: ClearFiltersIcon,
        },
        applyPreset: presets.applyPreset,
        openCreateDialog: () => {
          clearCommandCenterFocusRestoreElement();
          presets.openCreateDialog();
        },
        updateActivePreset: presets.updateActivePreset,
        clearFilters: presets.clearFilters,
      }),
    [presets, t],
  );

  useCommandCenterActions({ sourceId: "sidebar-presets", enabled: true, actions });
  return null;
}
