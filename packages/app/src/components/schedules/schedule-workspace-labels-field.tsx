import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  workspaceLabelKey,
  type WorkspaceLabelColor,
  type WorkspaceLabelDefinition,
} from "@getpaseo/protocol/workspace-labels";
import { Field } from "@/components/ui/form-field";
import { SelectFieldTrigger } from "@/components/ui/select-field";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  type MenuPageDefinition,
} from "@/components/ui/dropdown-menu";
import { useWorkspaceLabelProjection, workspaceLabels } from "@/workspace-labels";
import {
  WorkspaceLabelCreatePage,
  WorkspaceLabelCreateTrigger,
  WORKSPACE_LABEL_CREATE_PAGE_ID,
} from "@/workspace-labels/picker";
import { WorkspaceLabelDot } from "@/workspace-labels/swatch";
import type { ScheduleFormModel, ScheduleFormState } from "@/schedules/schedule-form-model";

export function ScheduleWorkspaceLabelsField({
  model,
  state,
  size,
}: {
  model: ScheduleFormModel;
  state: ScheduleFormState;
  size: FieldControlSize;
}) {
  const { t } = useTranslation();
  const { targetHost } = useWorkspaceLabelProjection(state.selectedServerId ?? undefined);
  const rows = useMemo(() => {
    const catalog = new Map<string, { name: string; color?: WorkspaceLabelColor }>(
      (targetHost?.labels ?? []).map((label) => [workspaceLabelKey(label.name), label]),
    );
    for (const name of state.workspaceLabels) {
      if (!catalog.has(workspaceLabelKey(name))) catalog.set(workspaceLabelKey(name), { name });
    }
    const assigned = new Set(state.workspaceLabels.map(workspaceLabelKey));
    return [...catalog.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((label) => ({
        name: label.name,
        color: label.color,
        assigned: assigned.has(workspaceLabelKey(label.name)),
      }));
  }, [targetHost?.labels, state.workspaceLabels]);

  const host = state.hosts.find((entry) => entry.serverId === state.selectedServerId);
  const create = useCallback(
    async (label: WorkspaceLabelDefinition) => {
      const serverId = state.selectedServerId;
      if (!serverId) return;
      const result = await workspaceLabels.create({ serverId, label });
      const draft = model.getState();
      if (
        draft.selectedServerId === serverId &&
        !draft.workspaceLabels.some(
          (name) => workspaceLabelKey(name) === workspaceLabelKey(result.label.name),
        )
      ) {
        model.toggleWorkspaceLabel(result.label.name);
      }
    },
    [model, state.selectedServerId],
  );
  const pages = useMemo<readonly MenuPageDefinition[]>(
    () =>
      state.selectedServerId && host?.supportsWorkspaceLabelCreation
        ? [
            {
              id: WORKSPACE_LABEL_CREATE_PAGE_ID,
              title: t("workspaceLabels.create"),
              hoverIntent: false,
              content: (
                <WorkspaceLabelCreatePage serverId={state.selectedServerId} onCreate={create} />
              ),
            },
          ]
        : [],
    [create, host?.supportsWorkspaceLabelCreation, state.selectedServerId, t],
  );

  if (!host?.supportsScheduleWorkspaceLabels) return null;

  return (
    <Field
      label={t("workspaceLabels.title")}
      error={state.workspaceLabelsInvalid ? t("workspaceLabels.staleSelection") : undefined}
    >
      <DropdownMenu compactMode="sheet">
        <DropdownMenuTrigger
          accessibilityRole="button"
          accessibilityLabel={t("workspaceLabels.title")}
          testID="schedule-labels-trigger"
        >
          {({ hovered, pressed, open }) => (
            <SelectFieldTrigger
              label={state.workspaceLabels.join(", ") || undefined}
              isPlaceholder={state.workspaceLabels.length === 0}
              placeholder={t("workspaceLabels.unlabelled")}
              active={hovered || pressed || open}
              size={size}
            />
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sheetTitle={t("workspaceLabels.title")} pages={pages}>
          {rows.map((row) => (
            <ScheduleLabelRow
              key={workspaceLabelKey(row.name)}
              row={row}
              onToggle={model.toggleWorkspaceLabel}
            />
          ))}
          {pages.length > 0 ? (
            <>
              {rows.length > 0 ? <DropdownMenuSeparator /> : null}
              <WorkspaceLabelCreateTrigger disabled={targetHost?.status !== "online"} />
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </Field>
  );
}

function ScheduleLabelRow({
  row,
  onToggle,
}: {
  row: { name: string; color?: WorkspaceLabelColor; assigned: boolean };
  onToggle: ScheduleFormModel["toggleWorkspaceLabel"];
}) {
  const leading = useMemo(
    () => (row.color ? <WorkspaceLabelDot color={row.color} /> : undefined),
    [row.color],
  );
  const onSelect = useCallback(() => onToggle(row.name), [onToggle, row.name]);
  return (
    <DropdownMenuItem
      leading={leading}
      selected={row.assigned}
      closeOnSelect={false}
      onSelect={onSelect}
      testID={`schedule-label-option-${row.name}`}
    >
      {row.name}
    </DropdownMenuItem>
  );
}
