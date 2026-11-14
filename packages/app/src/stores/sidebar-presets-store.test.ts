import { beforeEach, describe, expect, it } from "vitest";
import { useSidebarPresetsStore } from "./sidebar-presets-store";

describe("sidebar presets store", () => {
  beforeEach(() => {
    useSidebarPresetsStore.setState({ presets: [], activePresetId: null, nameDialog: null });
  });

  it("creates a preset with a trimmed name and makes it active", () => {
    const preset = useSidebarPresetsStore
      .getState()
      .createPreset("  Bugs  ", { groupMode: "status" });

    const state = useSidebarPresetsStore.getState();
    expect(preset.name).toBe("Bugs");
    expect(state.presets).toEqual([preset]);
    expect(state.activePresetId).toBe(preset.id);
  });

  it("updates and renames only the targeted preset", () => {
    const store = useSidebarPresetsStore.getState();
    const first = store.createPreset("First", { groupMode: "project" });
    const second = store.createPreset("Second", { groupMode: "project" });

    store.updatePresetView(first.id, { groupMode: "status" });
    store.renamePreset(second.id, " Renamed ");

    const [nextFirst, nextSecond] = useSidebarPresetsStore.getState().presets;
    expect(nextFirst).toMatchObject({ name: "First", view: { groupMode: "status" } });
    expect(nextSecond).toMatchObject({ name: "Renamed", view: { groupMode: "project" } });
  });

  it("clears the active preset when it is deleted", () => {
    const store = useSidebarPresetsStore.getState();
    const first = store.createPreset("First", {});
    const second = store.createPreset("Second", {});

    store.deletePreset(first.id);
    expect(useSidebarPresetsStore.getState().activePresetId).toBe(second.id);

    store.deletePreset(second.id);
    const state = useSidebarPresetsStore.getState();
    expect(state.presets).toEqual([]);
    expect(state.activePresetId).toBeNull();
  });
});
