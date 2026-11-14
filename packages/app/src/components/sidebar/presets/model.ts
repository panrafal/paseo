import { useCallback, useMemo } from "react";
import { useAppSettings, type AppSettings } from "@/hooks/use-settings";
import { DEFAULT_SIDEBAR_CHECKS_DISPLAY } from "@/components/sidebar/display-preferences/checks-display";
import {
  DEFAULT_SIDEBAR_ROW_ITEMS,
  SIDEBAR_ROW_ITEMS,
} from "@/components/sidebar/display-preferences/row-items";
import {
  hasActiveSidebarLabelFilter,
  useSidebarViewStore,
  type SidebarLabelFilter,
} from "@/stores/sidebar-view-store";
import {
  useSidebarPresetsStore,
  type SidebarPreset,
  type SidebarPresetView,
} from "@/stores/sidebar-presets-store";

/** The slice of the sidebar view store a preset captures. */
export interface SidebarPresetViewSource {
  groupMode: "project" | "status";
  workspaceSort: "manual" | "created" | "lastPrompt";
  showBackground: boolean;
  hostFilters: readonly string[];
  projectFilters: readonly string[];
  labelFilter: SidebarLabelFilter;
}

/** The slice of app settings a preset captures. */
export type SidebarPresetSettingsSource = Pick<
  AppSettings,
  "workspaceTitleSource" | "sidebarWorkspaceTrailing" | "sidebarRowItems" | "sidebarChecksDisplay"
>;

export function captureSidebarPresetView(
  view: SidebarPresetViewSource,
  settings: SidebarPresetSettingsSource,
): SidebarPresetView {
  return {
    groupMode: view.groupMode,
    workspaceSort: view.workspaceSort,
    showBackground: view.showBackground,
    hostFilters: [...view.hostFilters],
    projectFilters: [...view.projectFilters],
    labelFilters: [...view.labelFilter.labels],
    workspaceTitleSource: settings.workspaceTitleSource,
    sidebarWorkspaceTrailing: settings.sidebarWorkspaceTrailing,
    sidebarRowItems: { ...(settings.sidebarRowItems ?? DEFAULT_SIDEBAR_ROW_ITEMS) },
    sidebarChecksDisplay: settings.sidebarChecksDisplay ?? DEFAULT_SIDEBAR_CHECKS_DISPLAY,
  };
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((entry) => rightSet.has(entry));
}

/**
 * Whether the sidebar still shows what the preset says. Only the fields the preset holds count,
 * because applying it only touched those. Filters compare as sets: toggling a host off and back
 * on reorders the list without changing what the sidebar shows.
 */
const SCALAR_PRESET_FIELDS = [
  "groupMode",
  "workspaceSort",
  "showBackground",
  "workspaceTitleSource",
  "sidebarWorkspaceTrailing",
  "sidebarChecksDisplay",
] as const;

const LIST_PRESET_FIELDS = ["hostFilters", "projectFilters", "labelFilters"] as const;

export function sidebarPresetMatches(
  preset: SidebarPresetView,
  current: SidebarPresetView,
): boolean {
  for (const key of SCALAR_PRESET_FIELDS) {
    if (preset[key] !== undefined && preset[key] !== current[key]) return false;
  }
  for (const key of LIST_PRESET_FIELDS) {
    const expected = preset[key];
    if (expected !== undefined && !sameSet(expected, current[key] ?? [])) return false;
  }
  const rowItems = preset.sidebarRowItems;
  if (!rowItems) return true;
  return SIDEBAR_ROW_ITEMS.every(
    (item) => rowItems[item] === undefined || rowItems[item] === current.sidebarRowItems?.[item],
  );
}

type SidebarViewPatch = Partial<
  Pick<ReturnType<typeof useSidebarViewStore.getState>, keyof SidebarPresetViewSource>
>;

/** The view-store half of applying a preset: only the fields the preset holds. */
export function sidebarViewPatchFromPreset(view: SidebarPresetView): SidebarViewPatch {
  const patch: SidebarViewPatch = {};
  if (view.groupMode !== undefined) patch.groupMode = view.groupMode;
  if (view.workspaceSort !== undefined) patch.workspaceSort = view.workspaceSort;
  if (view.showBackground !== undefined) patch.showBackground = view.showBackground;
  if (view.hostFilters !== undefined) patch.hostFilters = [...view.hostFilters];
  if (view.projectFilters !== undefined) patch.projectFilters = [...view.projectFilters];
  if (view.labelFilters !== undefined) patch.labelFilter = { labels: [...view.labelFilters] };
  return patch;
}

/** The app-settings half of applying a preset. `null` when the preset holds none of them. */
export function sidebarSettingsPatchFromPreset(
  view: SidebarPresetView,
  currentRowItems: AppSettings["sidebarRowItems"] | undefined,
): Partial<SidebarPresetSettingsSource> | null {
  const patch: Partial<SidebarPresetSettingsSource> = {};
  if (view.workspaceTitleSource !== undefined) {
    patch.workspaceTitleSource = view.workspaceTitleSource;
  }
  if (view.sidebarWorkspaceTrailing !== undefined) {
    patch.sidebarWorkspaceTrailing = view.sidebarWorkspaceTrailing;
  }
  if (view.sidebarChecksDisplay !== undefined) {
    patch.sidebarChecksDisplay = view.sidebarChecksDisplay;
  }
  if (view.sidebarRowItems !== undefined) {
    patch.sidebarRowItems = {
      ...(currentRowItems ?? DEFAULT_SIDEBAR_ROW_ITEMS),
      ...view.sidebarRowItems,
    };
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

export function hasActiveSidebarFilters(view: SidebarPresetViewSource): boolean {
  return (
    view.hostFilters.length > 0 ||
    view.projectFilters.length > 0 ||
    hasActiveSidebarLabelFilter(view.labelFilter)
  );
}

export interface SidebarPresets {
  presets: readonly SidebarPreset[];
  activePreset: SidebarPreset | null;
  /** The active preset no longer matches what the sidebar shows. */
  activePresetModified: boolean;
  hasActiveFilters: boolean;
  applyPreset: (id: string) => void;
  /** Saves the current view under the name and makes it the active preset. */
  createPreset: (name: string) => void;
  /** Overwrites the active preset with the current view. */
  updateActivePreset: () => void;
  renamePreset: (id: string, name: string) => void;
  deletePreset: (id: string) => void;
  /** Drops the active preset and every host, project and label filter. */
  clearFilters: () => void;
  openCreateDialog: () => void;
  openRenameDialog: (id: string) => void;
}

/**
 * Saved views of the sidebar, behind one interface.
 *
 * A preset spans the same split `useSidebarDisplayPreferences` hides: grouping, sort and filters
 * live in the sidebar view store, title source and row items in app settings. Capturing reads
 * both; applying writes both.
 */
export function useSidebarPresets(): SidebarPresets {
  const presets = useSidebarPresetsStore((state) => state.presets);
  const activePresetId = useSidebarPresetsStore((state) => state.activePresetId);
  const groupMode = useSidebarViewStore((state) => state.groupMode);
  const workspaceSort = useSidebarViewStore((state) => state.workspaceSort);
  const showBackground = useSidebarViewStore((state) => state.showBackground);
  const hostFilters = useSidebarViewStore((state) => state.hostFilters);
  const projectFilters = useSidebarViewStore((state) => state.projectFilters);
  const labelFilter = useSidebarViewStore((state) => state.labelFilter);
  const {
    settings: {
      workspaceTitleSource,
      sidebarWorkspaceTrailing,
      sidebarRowItems,
      sidebarChecksDisplay,
    },
    updateSettings,
  } = useAppSettings();

  const viewSource = useMemo<SidebarPresetViewSource>(
    () => ({ groupMode, workspaceSort, showBackground, hostFilters, projectFilters, labelFilter }),
    [groupMode, workspaceSort, showBackground, hostFilters, projectFilters, labelFilter],
  );
  const currentView = useMemo(
    () =>
      captureSidebarPresetView(viewSource, {
        workspaceTitleSource,
        sidebarWorkspaceTrailing,
        sidebarRowItems,
        sidebarChecksDisplay,
      }),
    [
      viewSource,
      workspaceTitleSource,
      sidebarWorkspaceTrailing,
      sidebarRowItems,
      sidebarChecksDisplay,
    ],
  );

  const activePreset = useMemo(
    () => presets.find((preset) => preset.id === activePresetId) ?? null,
    [presets, activePresetId],
  );
  const activePresetModified = activePreset
    ? !sidebarPresetMatches(activePreset.view, currentView)
    : false;

  const applyPreset = useCallback(
    (id: string) => {
      const preset = useSidebarPresetsStore.getState().presets.find((entry) => entry.id === id);
      if (!preset) return;
      useSidebarViewStore.setState(sidebarViewPatchFromPreset(preset.view));
      if (sidebarSettingsPatchFromPreset(preset.view, undefined)) {
        void updateSettings(
          (current) => sidebarSettingsPatchFromPreset(preset.view, current.sidebarRowItems) ?? {},
        );
      }
      useSidebarPresetsStore.getState().setActivePresetId(id);
    },
    [updateSettings],
  );

  const createPreset = useCallback(
    (name: string) => {
      useSidebarPresetsStore.getState().createPreset(name, currentView);
    },
    [currentView],
  );

  const updateActivePreset = useCallback(() => {
    const id = useSidebarPresetsStore.getState().activePresetId;
    if (id) useSidebarPresetsStore.getState().updatePresetView(id, currentView);
  }, [currentView]);

  const renamePreset = useCallback((id: string, name: string) => {
    useSidebarPresetsStore.getState().renamePreset(id, name);
  }, []);

  const deletePreset = useCallback((id: string) => {
    useSidebarPresetsStore.getState().deletePreset(id);
  }, []);

  const clearFilters = useCallback(() => {
    const view = useSidebarViewStore.getState();
    view.clearHostFilters();
    view.clearProjectFilters();
    view.clearLabelFilter();
    useSidebarPresetsStore.getState().setActivePresetId(null);
  }, []);

  const openCreateDialog = useCallback(() => {
    useSidebarPresetsStore.getState().openNameDialog({ mode: "create" });
  }, []);

  const openRenameDialog = useCallback((id: string) => {
    useSidebarPresetsStore.getState().openNameDialog({ mode: "rename", presetId: id });
  }, []);

  const hasActiveFilters = hasActiveSidebarFilters(viewSource);

  return useMemo(
    () => ({
      presets,
      activePreset,
      activePresetModified,
      hasActiveFilters,
      applyPreset,
      createPreset,
      updateActivePreset,
      renamePreset,
      deletePreset,
      clearFilters,
      openCreateDialog,
      openRenameDialog,
    }),
    [
      presets,
      activePreset,
      activePresetModified,
      hasActiveFilters,
      applyPreset,
      createPreset,
      updateActivePreset,
      renamePreset,
      deletePreset,
      clearFilters,
      openCreateDialog,
      openRenameDialog,
    ],
  );
}
