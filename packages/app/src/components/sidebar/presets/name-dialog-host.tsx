import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { AdaptiveRenameModal } from "@/components/rename-modal";
import {
  normalizeSidebarPresetName,
  useSidebarPresetsStore,
  type SidebarPresetNameDialog,
} from "@/stores/sidebar-presets-store";
import { useSidebarPresets } from "./model";

/**
 * The one dialog that names a preset, mounted at the app root.
 *
 * The sidebar menu and the command center both open it, and the sidebar is not always on screen
 * when the command center asks — so it cannot live beside the menu.
 */
export function SidebarPresetNameDialogHost(): ReactElement | null {
  const { t } = useTranslation();
  const request = useSidebarPresetsStore((state) => state.nameDialog);
  const closeNameDialog = useSidebarPresetsStore((state) => state.closeNameDialog);
  const presets = useSidebarPresets();
  const [shown, setShown] = useState<SidebarPresetNameDialog | null>(null);

  // The command center closes in the same batch that asks for this dialog. Mounting it then puts
  // it behind the palette's portal on Android and loses focus to the palette's teardown on web,
  // so wait a frame — the same reason `WorkspaceRenameHost` does.
  useEffect(() => {
    if (!request) {
      setShown(null);
      return;
    }
    const frame = requestAnimationFrame(() => setShown(request));
    return () => cancelAnimationFrame(frame);
  }, [request]);

  const renaming =
    shown?.mode === "rename"
      ? (presets.presets.find((preset) => preset.id === shown.presetId) ?? null)
      : null;

  const validate = useCallback(
    (value: string) => {
      const name = normalizeSidebarPresetName(value).toLocaleLowerCase();
      const taken = presets.presets.some(
        (preset) => preset.id !== renaming?.id && preset.name.toLocaleLowerCase() === name,
      );
      return taken ? t("sidebar.presets.nameDialog.duplicate") : null;
    },
    [presets.presets, renaming?.id, t],
  );

  const { createPreset, renamePreset } = presets;
  const handleSubmit = useCallback(
    (value: string) => {
      if (renaming) {
        renamePreset(renaming.id, value);
      } else {
        createPreset(value);
      }
    },
    [createPreset, renamePreset, renaming],
  );

  if (shown?.mode === "rename" && !renaming) return null;

  return (
    <AdaptiveRenameModal
      visible={shown !== null}
      title={
        renaming
          ? t("sidebar.presets.nameDialog.renameTitle")
          : t("sidebar.presets.nameDialog.createTitle")
      }
      initialValue={renaming?.name ?? ""}
      placeholder={t("sidebar.presets.nameDialog.placeholder")}
      submitLabel={t("sidebar.presets.nameDialog.save")}
      onClose={closeNameDialog}
      onSubmit={handleSubmit}
      validate={validate}
      maxLength={60}
      testID="sidebar-preset-name-dialog"
    />
  );
}
