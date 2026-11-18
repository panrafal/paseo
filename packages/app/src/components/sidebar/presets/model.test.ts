import { describe, expect, it } from "vitest";
import { DEFAULT_SIDEBAR_ROW_ITEMS } from "@/components/sidebar/display-preferences/row-items";
import {
  captureSidebarPresetView,
  hasActiveSidebarFilters,
  sidebarPresetMatches,
  sidebarSettingsPatchFromPreset,
  sidebarViewPatchFromPreset,
  type SidebarPresetSettingsSource,
  type SidebarPresetViewSource,
} from "./model";

const view: SidebarPresetViewSource = {
  groupMode: "status",
  workspaceSort: "lastPrompt",
  showBackground: true,
  hostFilters: ["host-a", "host-b"],
  projectFilters: ["project-a"],
  labelFilter: { labels: ["bug"] },
};

const settings: SidebarPresetSettingsSource = {
  workspaceTitleSource: "branch",
  sidebarWorkspaceTrailing: "diff",
  sidebarRowItems: { ...DEFAULT_SIDEBAR_ROW_ITEMS, branch: true },
  sidebarChecksDisplay: "icon",
};

describe("sidebar presets model", () => {
  it("captures filters, grouping, sort and row items in one view", () => {
    expect(captureSidebarPresetView(view, settings)).toEqual({
      groupMode: "status",
      workspaceSort: "lastPrompt",
      showBackground: true,
      hostFilters: ["host-a", "host-b"],
      projectFilters: ["project-a"],
      labelFilters: ["bug"],
      workspaceTitleSource: "branch",
      sidebarWorkspaceTrailing: "diff",
      sidebarRowItems: { ...DEFAULT_SIDEBAR_ROW_ITEMS, branch: true },
      sidebarChecksDisplay: "icon",
    });
  });

  it("matches the view it captured, with filters in any order", () => {
    const preset = captureSidebarPresetView(view, settings);
    const reordered = captureSidebarPresetView(
      { ...view, hostFilters: ["host-b", "host-a"] },
      settings,
    );
    expect(sidebarPresetMatches(preset, reordered)).toBe(true);
  });

  it("stops matching once a filter or a row item changes", () => {
    const preset = captureSidebarPresetView(view, settings);
    expect(
      sidebarPresetMatches(
        preset,
        captureSidebarPresetView({ ...view, hostFilters: [] }, settings),
      ),
    ).toBe(false);
    expect(
      sidebarPresetMatches(
        preset,
        captureSidebarPresetView(view, {
          ...settings,
          sidebarRowItems: { ...settings.sidebarRowItems, branch: false },
        }),
      ),
    ).toBe(false);
  });

  it("ignores fields the preset does not hold", () => {
    const current = captureSidebarPresetView(view, settings);
    expect(sidebarPresetMatches({ groupMode: "status" }, current)).toBe(true);
    expect(sidebarPresetMatches({ groupMode: "project" }, current)).toBe(false);
  });

  it("applies only the fields a preset holds", () => {
    expect(sidebarViewPatchFromPreset({ hostFilters: ["host-a"], labelFilters: [] })).toEqual({
      hostFilters: ["host-a"],
      labelFilter: { labels: [] },
    });
    expect(sidebarSettingsPatchFromPreset({ groupMode: "project" }, undefined)).toBeNull();
  });

  it("merges stored row items over the current ones", () => {
    const patch = sidebarSettingsPatchFromPreset(
      { sidebarRowItems: { host: false } },
      { ...DEFAULT_SIDEBAR_ROW_ITEMS, branch: true },
    );
    expect(patch).toEqual({
      sidebarRowItems: { ...DEFAULT_SIDEBAR_ROW_ITEMS, branch: true, host: false },
    });
  });

  it("reports filters from hosts, projects or labels", () => {
    const unfiltered = {
      ...view,
      hostFilters: [],
      projectFilters: [],
      labelFilter: { labels: [] },
    };
    expect(hasActiveSidebarFilters(unfiltered)).toBe(false);
    expect(hasActiveSidebarFilters({ ...unfiltered, projectFilters: ["p"] })).toBe(true);
    expect(hasActiveSidebarFilters({ ...unfiltered, labelFilter: { labels: [""] } })).toBe(true);
  });
});
