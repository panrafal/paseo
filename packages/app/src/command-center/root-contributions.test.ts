import { describe, expect, it } from "vitest";
import type { SidebarGroupMode } from "@/stores/sidebar-view-store";
import type { CommandCenterIconProps } from "./contributions";
import {
  buildGroupingContribution,
  buildSidebarPresetContributions,
  type GroupingCommandCenterSource,
  type SidebarPresetsCommandCenterSource,
} from "./root-contributions";

function ProjectIcon(_props: CommandCenterIconProps) {
  return null;
}

function StatusIcon(_props: CommandCenterIconProps) {
  return null;
}

function source(groupMode: SidebarGroupMode): {
  value: GroupingCommandCenterSource;
  applied: SidebarGroupMode[];
} {
  const applied: SidebarGroupMode[] = [];
  return {
    value: {
      groupMode,
      labels: {
        section: "Actions",
        groupByProject: "Group by project",
        groupByStatus: "Group by status",
      },
      icons: { project: ProjectIcon, status: StatusIcon },
      shortcutKeys: [["mod", ";"]],
      setGroupMode: (mode) => applied.push(mode),
    },
    applied,
  };
}

describe("grouping command center contribution", () => {
  it("offers status while grouped by project", () => {
    const fixture = source("project");
    const contribution = buildGroupingContribution(fixture.value);

    expect(contribution.presentation).toMatchObject({
      title: "Group by status",
      icon: StatusIcon,
      shortcutKeys: [["mod", ";"]],
    });

    contribution.run();
    expect(fixture.applied).toEqual(["status"]);
  });

  it("offers project while grouped by status", () => {
    const fixture = source("status");
    const contribution = buildGroupingContribution(fixture.value);

    expect(contribution.presentation).toMatchObject({
      title: "Group by project",
      icon: ProjectIcon,
    });

    contribution.run();
    expect(fixture.applied).toEqual(["project"]);
  });

  it("keeps a stable id across both modes so the registry tiebreak never moves", () => {
    expect(buildGroupingContribution(source("project").value).id).toBe(
      buildGroupingContribution(source("status").value).id,
    );
  });

  it("stays out of the default empty-query list", () => {
    for (const mode of ["project", "status"] as const) {
      const contribution = buildGroupingContribution(source(mode).value);
      expect(contribution.visibility).toBe("query");
      expect(contribution.group).toBe("actions");
      // 6 is keyboard-shortcuts and 7 belongs to the workspace actions in #3013.
      expect(contribution.rank).toBe(8);
    }
  });
});

function presetSource(overrides: Partial<SidebarPresetsCommandCenterSource> = {}): {
  value: SidebarPresetsCommandCenterSource;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    value: {
      presets: [
        { id: "a", name: "Bugs" },
        { id: "b", name: "Release" },
      ],
      activePresetId: null,
      activePresetModified: false,
      hasActiveFilters: false,
      labels: {
        group: "Sidebar presets",
        save: "Save sidebar preset…",
        update: (name) => `Update ${name}`,
        clearFilters: "Clear sidebar filters",
      },
      icons: {},
      applyPreset: (id) => calls.push(`apply:${id}`),
      openCreateDialog: () => calls.push("create"),
      updateActivePreset: () => calls.push("update"),
      clearFilters: () => calls.push("clear"),
      ...overrides,
    },
    calls,
  };
}

describe("sidebar preset command center contributions", () => {
  it("lists every preset as a choice and always offers saving", () => {
    const fixture = presetSource();
    const contributions = buildSidebarPresetContributions(fixture.value);

    expect(contributions.map((entry) => entry.id)).toEqual([
      "sidebar-preset:a",
      "sidebar-preset:b",
      "sidebar-preset-save",
    ]);
    expect(contributions[0]?.presentation).toMatchObject({
      kind: "choice",
      path: ["Sidebar presets", "Bugs"],
      selected: false,
    });

    void contributions[1]?.run();
    void contributions[2]?.run();
    expect(fixture.calls).toEqual(["apply:b", "create"]);
  });

  it("ticks the active preset until the sidebar drifts from it", () => {
    const clean = buildSidebarPresetContributions(presetSource({ activePresetId: "a" }).value);
    expect(clean[0]?.presentation).toMatchObject({ selected: true });
    expect(clean.map((entry) => entry.id)).toContain("sidebar-preset-clear-filters");
    expect(clean.map((entry) => entry.id)).not.toContain("sidebar-preset-update");

    const drifted = buildSidebarPresetContributions(
      presetSource({ activePresetId: "a", activePresetModified: true }).value,
    );
    expect(drifted[0]?.presentation).toMatchObject({ selected: false });
    const update = drifted.find((entry) => entry.id === "sidebar-preset-update");
    expect(update?.presentation).toMatchObject({ title: "Update Bugs" });
  });

  it("offers clearing filters only when something is filtered", () => {
    const ids = (input: SidebarPresetsCommandCenterSource) =>
      buildSidebarPresetContributions(input).map((entry) => entry.id);
    expect(ids(presetSource().value)).not.toContain("sidebar-preset-clear-filters");
    expect(ids(presetSource({ hasActiveFilters: true }).value)).toContain(
      "sidebar-preset-clear-filters",
    );
  });
});
