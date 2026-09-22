import { useEffect, useState, useSyncExternalStore } from "react";
import { useWorkspaceLabelProjection, workspaceLabels } from "@/workspace-labels";
import { openScheduleForm, type ScheduleFormSnapshot } from "./schedule-form-model";

export function useScheduleFormModel(snapshot: ScheduleFormSnapshot) {
  const [model] = useState(() => openScheduleForm(snapshot));
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const { targetHost } = useWorkspaceLabelProjection(state.selectedServerId ?? undefined);
  useEffect(() => {
    model.applyWorkspaceLabelCatalog(
      state.selectedServerId,
      targetHost?.labels.map((label) => label.name) ?? [],
    );
  }, [model, state.selectedServerId, targetHost?.labels]);
  useEffect(() => workspaceLabels.subscribeChanges(model.applyWorkspaceLabelChange), [model]);

  useEffect(() => {
    return () => {
      model.close();
    };
  }, [model]);

  useEffect(() => {
    model.applyHosts(snapshot.hosts);
    model.applyProjectTargets(snapshot.defaults.projectTargets);
    model.applyPreferences(snapshot.defaults.preferences);
  }, [model, snapshot.hosts, snapshot.defaults.preferences, snapshot.defaults.projectTargets]);

  return model;
}
