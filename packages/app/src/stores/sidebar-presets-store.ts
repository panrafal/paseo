import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { SIDEBAR_CHECKS_DISPLAYS } from "@/components/sidebar/display-preferences/checks-display";
import { SIDEBAR_ROW_ITEMS } from "@/components/sidebar/display-preferences/row-items";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

const SIDEBAR_PRESETS_STORAGE_KEY = "sidebar-presets";
const SIDEBAR_PRESETS_STORE_VERSION = 1;

/**
 * Every field is optional and falls back to `undefined` on a bad value, so a preset written by a
 * newer build — or one that names a value this build dropped — still loads. Applying a preset only
 * touches the fields it has; capturing always writes all of them.
 */
const SidebarPresetViewSchema = z.object({
  groupMode: z.enum(["project", "status"]).optional().catch(undefined),
  workspaceSort: z.enum(["manual", "created", "lastPrompt"]).optional().catch(undefined),
  showBackground: z.boolean().optional().catch(undefined),
  hostFilters: z.array(z.string()).optional().catch(undefined),
  projectFilters: z.array(z.string()).optional().catch(undefined),
  labelFilters: z.array(z.string()).optional().catch(undefined),
  workspaceTitleSource: z.enum(["title", "branch"]).optional().catch(undefined),
  sidebarWorkspaceTrailing: z.enum(["diff", "timestamp", "none"]).optional().catch(undefined),
  sidebarRowItems: z
    .partialRecord(z.enum(SIDEBAR_ROW_ITEMS), z.boolean())
    .optional()
    .catch(undefined),
  sidebarChecksDisplay: z.enum(SIDEBAR_CHECKS_DISPLAYS).optional().catch(undefined),
});

export type SidebarPresetView = z.infer<typeof SidebarPresetViewSchema>;

const SidebarPresetSchema = z.object({
  id: z.string(),
  name: z.string(),
  view: SidebarPresetViewSchema,
});

export type SidebarPreset = z.infer<typeof SidebarPresetSchema>;

const SidebarPresetsPersistedStateSchema = z.object({
  presets: z.array(SidebarPresetSchema),
  activePresetId: z.string().nullable(),
});

type SidebarPresetsPersistedState = z.infer<typeof SidebarPresetsPersistedStateSchema>;

/** The name dialog is opened from both the sidebar menu and the command center. */
export type SidebarPresetNameDialog = { mode: "create" } | { mode: "rename"; presetId: string };

interface SidebarPresetsStoreState extends SidebarPresetsPersistedState {
  nameDialog: SidebarPresetNameDialog | null;
  createPreset: (name: string, view: SidebarPresetView) => SidebarPreset;
  updatePresetView: (id: string, view: SidebarPresetView) => void;
  renamePreset: (id: string, name: string) => void;
  deletePreset: (id: string) => void;
  setActivePresetId: (id: string | null) => void;
  openNameDialog: (dialog: SidebarPresetNameDialog) => void;
  closeNameDialog: () => void;
}

export function normalizeSidebarPresetName(name: string): string {
  return name.trim();
}

function createPresetId(): string {
  return `preset-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export const useSidebarPresetsStore = create<SidebarPresetsStoreState>()(
  persist(
    (set) => ({
      presets: [],
      activePresetId: null,
      nameDialog: null,
      createPreset: (name, view) => {
        const preset: SidebarPreset = {
          id: createPresetId(),
          name: normalizeSidebarPresetName(name),
          view,
        };
        set((state) => ({ presets: [...state.presets, preset], activePresetId: preset.id }));
        return preset;
      },
      updatePresetView: (id, view) =>
        set((state) => ({
          presets: state.presets.map((preset) => (preset.id === id ? { ...preset, view } : preset)),
        })),
      renamePreset: (id, name) =>
        set((state) => ({
          presets: state.presets.map((preset) =>
            preset.id === id ? { ...preset, name: normalizeSidebarPresetName(name) } : preset,
          ),
        })),
      deletePreset: (id) =>
        set((state) => ({
          presets: state.presets.filter((preset) => preset.id !== id),
          activePresetId: state.activePresetId === id ? null : state.activePresetId,
        })),
      setActivePresetId: (id) => set({ activePresetId: id }),
      openNameDialog: (dialog) => set({ nameDialog: dialog }),
      closeNameDialog: () => set({ nameDialog: null }),
    }),
    {
      name: SIDEBAR_PRESETS_STORAGE_KEY,
      version: SIDEBAR_PRESETS_STORE_VERSION,
      storage: createValidatedPersistStorage(AsyncStorage, SidebarPresetsPersistedStateSchema),
      partialize: (state) => ({
        presets: state.presets,
        activePresetId: state.activePresetId,
      }),
    },
  ),
);
