import { useSuspenseQuery } from "@tanstack/react-query";
import type { WindowDraft } from "../../automations/automation-form.ts";
import { automationTargetsQuery } from "../../data/automation-form-mutations.ts";
import type { EnvironmentScope } from "../../scope.ts";
import { Checkbox } from "@/components/ui/checkbox";
import { CheckboxField, Description, Field, Label } from "@/components/ui/field";
import { NativeSelect } from "@/components/ui/native-select";
import { TimePicker, TimePickerContent, TimePickerInput } from "@/components/reui/time-picker";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function WorkspaceField({
  onChange,
  scope,
  value,
}: Readonly<{ onChange: (value: string) => void; scope: EnvironmentScope; value: string }>) {
  const { data: targets } = useSuspenseQuery(automationTargetsQuery(scope));
  return (
    <Field>
      <Label>Workspace (optional)</Label>
      <Description>Runs, usage, and connection grants name this workspace.</Description>
      <NativeSelect
        name="workspaceId"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        <option value="">No workspace</option>
        {targets.workspaces.map((workspace) => (
          <option key={workspace.id} value={workspace.id}>
            {workspace.name}
          </option>
        ))}
      </NativeSelect>
    </Field>
  );
}

export function ActiveWindowFields({
  invalid,
  onChange,
  value,
}: Readonly<{ invalid: boolean; onChange: (value: WindowDraft) => void; value: WindowDraft }>) {
  return (
    <>
      <CheckboxField>
        <Checkbox
          checked={value.enabled}
          name="windowEnabled"
          onCheckedChange={(enabled) => onChange({ ...value, enabled })}
        />
        <Label>Only inside an active window</Label>
        <Description>Beats outside the window are skipped.</Description>
      </CheckboxField>
      {value.enabled ? (
        <Field invalid={invalid}>
          <Label>Active window</Label>
          <Description>
            Start and end in the heartbeat&apos;s time zone; 00:00 as the end means midnight. No day
            selected means every day.
          </Description>
          <div className="flex gap-3">
            <TimePicker
              aria-label="Window start"
              invalid={invalid}
              name="windowStart"
              onValueChange={(start) => onChange({ ...value, start: start ?? "" })}
              value={value.start || null}
            >
              <TimePickerInput />
              <TimePickerContent />
            </TimePicker>
            <TimePicker
              aria-label="Window end"
              invalid={invalid}
              name="windowEnd"
              onValueChange={(end) => onChange({ ...value, end: end ?? "" })}
              value={value.end || null}
            >
              <TimePickerInput />
              <TimePickerContent />
            </TimePicker>
          </div>
          <div className="flex flex-wrap gap-4">
            {WEEKDAYS.map((day, index) => (
              <CheckboxField key={day}>
                <Checkbox
                  checked={value.days.includes(index)}
                  onCheckedChange={(checked) =>
                    onChange({
                      ...value,
                      days: checked
                        ? [...value.days, index]
                        : value.days.filter((candidate) => candidate !== index),
                    })
                  }
                />
                <Label>{day}</Label>
              </CheckboxField>
            ))}
          </div>
        </Field>
      ) : null}
    </>
  );
}
