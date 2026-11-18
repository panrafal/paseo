import { nextSidebarGroupMode, type SidebarGroupMode } from "@/stores/sidebar-view-store";
import type { ShortcutKey } from "@/utils/format-shortcut";
import type { CommandCenterContribution, CommandCenterIcon } from "./contributions";

export interface GroupingCommandCenterSource {
  groupMode: SidebarGroupMode;
  labels: {
    section: string;
    groupByProject: string;
    groupByStatus: string;
  };
  icons: {
    project?: CommandCenterIcon;
    status?: CommandCenterIcon;
  };
  shortcutKeys: ShortcutKey[][] | undefined;
  setGroupMode(mode: SidebarGroupMode): void;
}

// One entry that always names the mode you are not in, so it can never read as a no-op.
export function buildGroupingContribution(
  source: GroupingCommandCenterSource,
): CommandCenterContribution {
  const target = nextSidebarGroupMode(source.groupMode);
  return {
    id: "sidebar-grouping",
    group: "actions",
    groupRank: 0,
    rank: 8,
    keywords: ["group", "grouping", "sort", "sidebar", "project", "status"],
    visibility: "query",
    run: () => source.setGroupMode(target),
    presentation: {
      kind: "action",
      title: target === "status" ? source.labels.groupByStatus : source.labels.groupByProject,
      sectionTitle: source.labels.section,
      icon: target === "status" ? source.icons.status : source.icons.project,
      shortcutKeys: source.shortcutKeys,
    },
  };
}

export interface SidebarPresetsCommandCenterSource {
  presets: readonly { id: string; name: string }[];
  activePresetId: string | null;
  activePresetModified: boolean;
  hasActiveFilters: boolean;
  labels: {
    group: string;
    save: string;
    update: (name: string) => string;
    clearFilters: string;
  };
  icons: {
    preset?: CommandCenterIcon;
    save?: CommandCenterIcon;
    update?: CommandCenterIcon;
    clearFilters?: CommandCenterIcon;
  };
  applyPreset(id: string): void;
  openCreateDialog(): void;
  updateActivePreset(): void;
  clearFilters(): void;
}

const SIDEBAR_PRESET_KEYWORDS = ["sidebar", "preset", "presets", "view", "saved", "filter"];

/**
 * One choice per saved preset, ticked while the sidebar still shows it, plus the actions that
 * make sense right now. Picking the ticked preset re-applies it rather than no-op'ing: the
 * sidebar can have drifted in a way the tick does not show, such as a removed field.
 */
export function buildSidebarPresetContributions(
  source: SidebarPresetsCommandCenterSource,
): CommandCenterContribution[] {
  const contributions: CommandCenterContribution[] = source.presets.map((preset, index) => ({
    id: `sidebar-preset:${preset.id}`,
    group: "sidebar-presets",
    groupRank: 0,
    rank: index,
    keywords: [...SIDEBAR_PRESET_KEYWORDS, preset.name],
    visibility: "query",
    run: () => source.applyPreset(preset.id),
    presentation: {
      kind: "choice",
      path: [source.labels.group, preset.name],
      icon: source.icons.preset,
      selected: preset.id === source.activePresetId && !source.activePresetModified,
      testId: `command-center-sidebar-preset-${preset.id}`,
    },
  }));

  const offset = contributions.length;
  contributions.push({
    id: "sidebar-preset-save",
    group: "sidebar-presets",
    groupRank: 0,
    rank: offset,
    keywords: [...SIDEBAR_PRESET_KEYWORDS, "save", "new", "create", "add"],
    visibility: "query",
    run: source.openCreateDialog,
    presentation: {
      kind: "action",
      title: source.labels.save,
      sectionTitle: source.labels.group,
      icon: source.icons.save,
    },
  });

  const activePreset = source.presets.find((preset) => preset.id === source.activePresetId);
  if (activePreset && source.activePresetModified) {
    contributions.push({
      id: "sidebar-preset-update",
      group: "sidebar-presets",
      groupRank: 0,
      rank: offset + 1,
      keywords: [...SIDEBAR_PRESET_KEYWORDS, "update", "overwrite", activePreset.name],
      visibility: "query",
      run: source.updateActivePreset,
      presentation: {
        kind: "action",
        title: source.labels.update(activePreset.name),
        sectionTitle: source.labels.group,
        icon: source.icons.update,
      },
    });
  }

  if (activePreset || source.hasActiveFilters) {
    contributions.push({
      id: "sidebar-preset-clear-filters",
      group: "sidebar-presets",
      groupRank: 0,
      rank: offset + 2,
      keywords: [...SIDEBAR_PRESET_KEYWORDS, "clear", "reset", "all"],
      visibility: "query",
      run: source.clearFilters,
      presentation: {
        kind: "action",
        title: source.labels.clearFilters,
        sectionTitle: source.labels.group,
        icon: source.icons.clearFilters,
      },
    });
  }

  return contributions;
}
