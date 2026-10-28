import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/contexts/toast-context";
import { openDesktopTarget, useDesktopOpenTargets } from "@/workspace/desktop-open-targets";
import { useDesktopOpenExecution } from "@/workspace/open-in-editor/remote-destination";

/**
 * Opens a folder outside the workspace in the system file manager. The Files
 * panel only lists the workspace, so hosts without a local file manager get a
 * toast instead.
 */
export function useOpenOutsideWorkspaceFolder(serverId: string): (folderPath: string) => void {
  const { t } = useTranslation();
  const toast = useToast();
  const desktopOpenExecution = useDesktopOpenExecution(serverId);
  const execution =
    desktopOpenExecution?.kind === "remote-unconfigured" ? null : desktopOpenExecution;
  const remoteDestination = execution?.kind === "remote" ? execution.destination : undefined;
  const { targets } = useDesktopOpenTargets({ execution });
  const fileManagerTarget = targets.find((target) => target.kind === "file-manager");

  return useCallback(
    (folderPath: string) => {
      const showOutsideWorkspace = () =>
        toast.show(t("common.errors.folderOutsideWorkspace", { path: folderPath }));
      if (!fileManagerTarget) {
        showOutsideWorkspace();
        return;
      }
      void openDesktopTarget({
        editorId: fileManagerTarget.id,
        workspacePath: folderPath,
        remoteDestination,
      }).catch(
        (error: unknown) => {
          console.warn("[open-outside-workspace-folder] open failed", error);
          showOutsideWorkspace();
        },
      );
    },
    [fileManagerTarget, remoteDestination, t, toast],
  );
}
