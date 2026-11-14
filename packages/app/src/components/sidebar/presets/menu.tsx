import { useCallback, useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Bookmark, BookmarkPlus, FilterX, Pencil, RefreshCw, Trash2 } from "lucide-react-native";
import {
  MenuHint,
  MenuItem,
  MenuRoot,
  MenuSeparator,
  MenuSurface,
  MenuTrigger,
  type MenuTriggerState,
} from "@/components/ui/menu";
import { isWeb } from "@/constants/platform";
import type { Theme } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";
import type { SidebarPreset } from "@/stores/sidebar-presets-store";
import { useSidebarPresets } from "./model";

const MENU_WIDTH = 260;
const OPTION_ICON_SIZE = 14;

const ThemedBookmark = withUnistyles(Bookmark);
const ThemedBookmarkPlus = withUnistyles(BookmarkPlus);
const ThemedRefreshCw = withUnistyles(RefreshCw);
const ThemedPencil = withUnistyles(Pencil);
const ThemedTrash2 = withUnistyles(Trash2);
const ThemedFilterX = withUnistyles(FilterX);

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundIconMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const accentIconMapping = (theme: Theme) => ({ color: theme.colors.accent });
const destructiveIconMapping = (theme: Theme) => ({ color: theme.colors.destructive });

const PRESET_LEADING = <ThemedBookmark size={OPTION_ICON_SIZE} uniProps={mutedIconMapping} />;
const SAVE_LEADING = <ThemedBookmarkPlus size={OPTION_ICON_SIZE} uniProps={mutedIconMapping} />;
const UPDATE_LEADING = <ThemedRefreshCw size={OPTION_ICON_SIZE} uniProps={mutedIconMapping} />;
const RENAME_LEADING = <ThemedPencil size={OPTION_ICON_SIZE} uniProps={mutedIconMapping} />;
const DELETE_LEADING = <ThemedTrash2 size={OPTION_ICON_SIZE} uniProps={destructiveIconMapping} />;
const CLEAR_LEADING = <ThemedFilterX size={OPTION_ICON_SIZE} uniProps={mutedIconMapping} />;

function triggerIconMapping(state: MenuTriggerState, active: boolean) {
  if (active) return accentIconMapping;
  return state.hovered || state.pressed || state.open ? foregroundIconMapping : mutedIconMapping;
}

/**
 * Saved views of the sidebar, opened from the Workspaces header.
 *
 * Always an icon; with room to spare it carries the active preset's name too. The icon takes the
 * accent while a preset is active, and a dot joins it once the sidebar has drifted from the
 * preset, which is exactly when Update has something to save.
 */
export function SidebarPresetsMenu({ showLabel }: { showLabel: boolean }): ReactElement {
  const { t } = useTranslation();
  const presets = useSidebarPresets();
  const { activePreset, activePresetModified } = presets;

  const triggerStyle = useCallback(
    ({ hovered, pressed, open }: MenuTriggerState) => [
      styles.trigger,
      (hovered || pressed || open) && styles.triggerHighlighted,
    ],
    [],
  );

  const accessibilityLabel = activePreset
    ? t("sidebar.presets.triggerActive", { name: activePreset.name })
    : t("sidebar.presets.trigger");

  const { deletePreset } = presets;
  const handleDelete = useCallback(async () => {
    if (!activePreset) return;
    const { id, name } = activePreset;
    const confirmed = await confirmDialog({
      title: t("sidebar.presets.deleteConfirm.title"),
      message: t("sidebar.presets.deleteConfirm.message", { name }),
      confirmLabel: t("sidebar.presets.deleteConfirm.confirm"),
      cancelLabel: t("common.actions.cancel"),
      destructive: true,
    });
    if (confirmed) deletePreset(id);
  }, [activePreset, deletePreset, t]);
  const handleDeleteSelect = useCallback(() => {
    void handleDelete();
  }, [handleDelete]);

  const handleRename = useCallback(() => {
    if (activePreset) presets.openRenameDialog(activePreset.id);
  }, [activePreset, presets]);

  return (
    <MenuRoot compactMode="sheet">
      <MenuTrigger
        style={triggerStyle}
        accessibilityRole={isWeb ? undefined : "button"}
        accessibilityLabel={accessibilityLabel}
        testID="sidebar-presets-menu"
      >
        {(state) => (
          <>
            <ThemedBookmark
              size={14}
              uniProps={triggerIconMapping(state, activePreset !== null)}
              testID={activePreset ? "sidebar-presets-icon-active" : "sidebar-presets-icon"}
            />
            {showLabel && activePreset ? (
              <Text style={styles.triggerLabel} numberOfLines={1} testID="sidebar-presets-label">
                {activePreset.name}
              </Text>
            ) : null}
            {activePresetModified ? (
              <View style={styles.modifiedDot} testID="sidebar-presets-modified" />
            ) : null}
          </>
        )}
      </MenuTrigger>
      <MenuSurface
        align="end"
        width={MENU_WIDTH}
        sheetTitle={t("sidebar.presets.heading")}
        testID="sidebar-presets-content"
      >
        {presets.presets.length === 0 ? (
          <MenuHint testID="sidebar-presets-empty">{t("sidebar.presets.empty")}</MenuHint>
        ) : (
          presets.presets.map((preset) => (
            <PresetItem
              key={preset.id}
              preset={preset}
              active={preset.id === activePreset?.id}
              modified={preset.id === activePreset?.id && activePresetModified}
              onApply={presets.applyPreset}
            />
          ))
        )}
        <MenuSeparator />
        <MenuItem
          leading={SAVE_LEADING}
          onSelect={presets.openCreateDialog}
          testID="sidebar-presets-save"
        >
          {t("sidebar.presets.save")}
        </MenuItem>
        {activePreset ? (
          <>
            <MenuItem
              leading={UPDATE_LEADING}
              disabled={!activePresetModified}
              onSelect={presets.updateActivePreset}
              testID="sidebar-presets-update"
            >
              {t("sidebar.presets.update", { name: activePreset.name })}
            </MenuItem>
            <MenuItem
              leading={RENAME_LEADING}
              onSelect={handleRename}
              testID="sidebar-presets-rename"
            >
              {t("sidebar.presets.rename", { name: activePreset.name })}
            </MenuItem>
            <MenuItem
              leading={DELETE_LEADING}
              destructive
              onSelect={handleDeleteSelect}
              testID="sidebar-presets-delete"
            >
              {t("sidebar.presets.delete", { name: activePreset.name })}
            </MenuItem>
          </>
        ) : null}
        <MenuSeparator />
        <MenuItem
          leading={CLEAR_LEADING}
          disabled={!activePreset && !presets.hasActiveFilters}
          onSelect={presets.clearFilters}
          testID="sidebar-presets-clear-filters"
        >
          {t("sidebar.presets.clearFilters")}
        </MenuItem>
      </MenuSurface>
    </MenuRoot>
  );
}

/** Pressing the active preset re-applies it, which is how you throw away drift. */
function PresetItem({
  preset,
  active,
  modified,
  onApply,
}: {
  preset: SidebarPreset;
  active: boolean;
  modified: boolean;
  onApply: (id: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handleSelect = useCallback(() => onApply(preset.id), [onApply, preset.id]);
  const description = useMemo(
    () => (modified ? t("sidebar.presets.modified") : undefined),
    [modified, t],
  );
  return (
    <MenuItem
      leading={PRESET_LEADING}
      selected={active}
      description={description}
      onSelect={handleSelect}
      testID={`sidebar-presets-item-${preset.id}`}
    >
      {preset.name}
    </MenuItem>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    height: 28,
    minWidth: 28,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1],
    paddingHorizontal: 7,
    borderRadius: theme.borderRadius.md,
  },
  triggerHighlighted: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  triggerLabel: {
    maxWidth: 120,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  modifiedDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: theme.colors.accent,
  },
}));
