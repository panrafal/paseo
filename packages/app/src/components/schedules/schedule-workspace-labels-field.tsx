import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { workspaceLabelKey } from "@getpaseo/protocol/workspace-labels";
import { Field } from "@/components/ui/form-field";
import { SelectFieldTrigger } from "@/components/ui/select-field";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuHint,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  buildWorkspaceLabelPickerRows,
  useWorkspaceLabelProjection,
  type WorkspaceLabelPickerRow,
} from "@/workspace-labels";
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
  const { labels, targetHost } = useWorkspaceLabelProjection(state.selectedServerId ?? undefined);
  const rows = useMemo(() => {
    // Keep saved selections removable even if their catalog entries have been deleted.
    const catalog = new Map(labels.map((label) => [workspaceLabelKey(label.name), label]));
    for (const label of state.workspaceLabels) {
      if (!catalog.has(workspaceLabelKey(label.name)))
        catalog.set(workspaceLabelKey(label.name), label);
    }
    return buildWorkspaceLabelPickerRows({
      labels: [...catalog.values()],
      assigned: state.workspaceLabels.map((label) => label.name),
    });
  }, [labels, state.workspaceLabels]);

  return (
    <Field label={t("workspaceLabels.title")}>
      <DropdownMenu>
        <DropdownMenuTrigger
          accessibilityRole="button"
          accessibilityLabel={t("workspaceLabels.title")}
          testID="schedule-labels-trigger"
        >
          {({ hovered, pressed, open }) => (
            <SelectFieldTrigger
              label={state.workspaceLabels.map((label) => label.name).join(", ") || undefined}
              isPlaceholder={state.workspaceLabels.length === 0}
              placeholder={t("workspaceLabels.unlabelled")}
              active={hovered || pressed || open}
              size={size}
            />
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sheetTitle={t("workspaceLabels.title")}>
          {rows.map((row) => (
            <ScheduleLabelRow
              key={workspaceLabelKey(row.name)}
              row={row}
              onToggle={model.toggleWorkspaceLabel}
            />
          ))}
          {rows.length === 0 ? (
            <DropdownMenuHint>{t("workspaceLabels.manage.empty")}</DropdownMenuHint>
          ) : null}
          {targetHost?.error ? <DropdownMenuHint>{targetHost.error}</DropdownMenuHint> : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </Field>
  );
}

function ScheduleLabelRow({
  row,
  onToggle,
}: {
  row: WorkspaceLabelPickerRow;
  onToggle: ScheduleFormModel["toggleWorkspaceLabel"];
}) {
  const leading = useMemo(() => <WorkspaceLabelDot color={row.color} />, [row.color]);
  const onSelect = useCallback(
    () => onToggle({ name: row.name, color: row.color }),
    [onToggle, row.name, row.color],
  );
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
