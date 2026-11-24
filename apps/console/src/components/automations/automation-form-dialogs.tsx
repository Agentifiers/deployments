import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import {
  CADENCE_KINDS,
  checkHeartbeatCreate,
  checkHeartbeatEdit,
  checkScheduleCreate,
  checkScheduleEdit,
  heartbeatEditDraft,
  newHeartbeatDraft,
  newScheduleDraft,
  RATE_UNITS,
  scheduleEditDraft,
  scheduleExpression,
  type CadenceDraft,
  type HeartbeatDraft,
  type ScheduleDraft,
} from "../../automations/automation-form.ts";
import {
  automationPath,
  type AutomationEntry,
  type AutomationKind,
  type Heartbeat,
  type Schedule,
} from "../../automations/automation-state.ts";
import { describeCadence, parseScheduleExpression } from "../../automations/cadence.ts";
import {
  automationTargetsQuery,
  createHeartbeatFn,
  createScheduleFn,
  updateHeartbeatFn,
  updateScheduleFn,
} from "../../data/automation-form-mutations.ts";
import { invalidateAutomations } from "../../data/automation-queries.ts";
import { environmentQuery } from "../../data/console-queries.ts";
import { agentDirectoryQuery } from "../../data/observability-queries.ts";
import { agentLabels } from "../../observability/agent-labels.ts";
import type { EnvironmentScope } from "../../scope.ts";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import { Checkbox } from "@/components/ui/checkbox";
import { CheckboxField, Description, Field, Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { ActionDialog, refreshOnConflict, typedConfirmation } from "../action-dialog.tsx";
import { DateTimePicker } from "../date-picker.tsx";
import { useKeyedSnapshot } from "../keyed-snapshot.ts";
import { ActiveWindowFields, WorkspaceField } from "./automation-form-fields.tsx";

const BROWSER_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

const START_PAUSED_NOTE =
  "Pauses right after it is created, so it does not fire until you resume it.";

function useRefresh(scope: EnvironmentScope) {
  const queryClient = useQueryClient();
  return () => invalidateAutomations(queryClient, scope);
}

function useOpenCreated(scope: EnvironmentScope) {
  const navigate = useNavigate();
  return (entry: AutomationEntry) => {
    const record = entry.kind === "schedule" ? entry.schedule : entry.heartbeat;
    void navigate({ href: automationPath(scope, { id: record.id, kind: entry.kind }) });
  };
}

function DeploymentField({
  invalid,
  kind,
  onChange,
  scope,
  value,
}: Readonly<{
  invalid: boolean;
  kind: AutomationKind;
  onChange: (value: string) => void;
  scope: EnvironmentScope;
  value: string;
}>) {
  const { data: targets } = useSuspenseQuery(automationTargetsQuery(scope));
  const { data: directory } = useSuspenseQuery(agentDirectoryQuery(scope));
  const labels = agentLabels(directory);
  const options = targets.deployments
    .filter((deployment) => deployment.kinds.includes(kind))
    .map(({ id }) => ({ id, label: labels.deployment(id) }));
  const sameLabel = Map.groupBy(options, (option) => option.label);
  return (
    <Field invalid={invalid}>
      <Label>Deployment</Label>
      <Description>
        {options.length === 0
          ? `No ready, running deployment allows ${kind} runs. Deploy an agent whose release allows the ${kind} trigger.`
          : `Each fire starts a run on this deployment. Only ready, running deployments whose release allows ${kind} runs are listed.`}
      </Description>
      <NativeSelect
        aria-invalid={invalid}
        name="agentDeploymentId"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        <option value="">Choose a deployment</option>
        {options.map(({ id, label }) => (
          <option key={id} value={id}>
            {/* Distinct agents can share a name, so repeated labels need the ID to differ. */}
            {(sameLabel.get(label)?.length ?? 0) > 1 ? `${label} · ${id.slice(-6)}` : label}
          </option>
        ))}
      </NativeSelect>
    </Field>
  );
}

function TimezoneField({
  invalid,
  onChange,
  value,
}: Readonly<{ invalid: boolean; onChange: (value: string) => void; value: string }>) {
  return (
    <Field invalid={invalid}>
      <Label>Time zone</Label>
      <Description>An IANA time zone such as UTC or Europe/Berlin.</Description>
      <Input
        aria-invalid={invalid}
        autoComplete="off"
        name="timezone"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      />
    </Field>
  );
}

function CadenceFields({
  invalid,
  onChange,
  timezone,
  value,
}: Readonly<{
  invalid: boolean;
  onChange: (value: CadenceDraft) => void;
  timezone: string;
  value: CadenceDraft;
}>) {
  const expression = scheduleExpression(value);
  const preview =
    expression === undefined
      ? undefined
      : describeCadence({
          expression: parseScheduleExpression(expression),
          kind: "schedule",
          raw: expression,
          timeZone: timezone || "UTC",
        });
  return (
    <>
      <Field>
        <Label>Repeats</Label>
        <NativeSelect
          name="cadenceKind"
          onChange={(event) => {
            const kind = CADENCE_KINDS.find((option) => option.kind === event.target.value)?.kind;
            if (kind === "rate") onChange({ every: "1", kind, unit: "day" });
            if (kind === "at") onChange({ kind, wallTime: "" });
            if (kind === "cron") onChange({ fields: "0 9 ? * MON-FRI *", kind });
          }}
          value={value.kind}
        >
          {CADENCE_KINDS.map((option) => (
            <option key={option.kind} value={option.kind}>
              {option.label}
            </option>
          ))}
        </NativeSelect>
      </Field>
      {value.kind === "rate" ? (
        <Field invalid={invalid}>
          <Label>Every</Label>
          <div className="flex gap-3">
            <Input
              aria-invalid={invalid}
              inputMode="numeric"
              name="every"
              onChange={(event) => onChange({ ...value, every: event.target.value })}
              value={value.every}
            />
            <NativeSelect
              name="unit"
              onChange={(event) => {
                const unit = RATE_UNITS.find((candidate) => candidate === event.target.value);
                if (unit) onChange({ ...value, unit });
              }}
              value={value.unit}
            >
              {RATE_UNITS.map((unit) => (
                <option key={unit} value={unit}>
                  {unit}s
                </option>
              ))}
            </NativeSelect>
          </div>
        </Field>
      ) : null}
      {value.kind === "at" ? (
        <Field invalid={invalid}>
          <Label>At</Label>
          <Description>Local time in the schedule&apos;s time zone. It fires once.</Description>
          <DateTimePicker
            invalid={invalid}
            label="At"
            onChange={(wallTime) => onChange({ ...value, wallTime })}
            value={value.wallTime.slice(0, 16)}
          />
        </Field>
      ) : null}
      {value.kind === "cron" ? (
        <Field invalid={invalid}>
          <Label>Cron fields</Label>
          <Description>
            Six EventBridge fields: minute, hour, day of month, month, day of week, year. One of the
            two day fields must be ?.
          </Description>
          <Input
            aria-invalid={invalid}
            autoComplete="off"
            className="font-mono"
            name="cron"
            onChange={(event) => onChange({ ...value, fields: event.target.value })}
            value={value.fields}
          />
        </Field>
      ) : null}
      <p className="text-sm/6 text-muted-foreground">
        {preview ? `${preview}. Sends ${expression}.` : "Enter a valid cadence to preview it."}
      </p>
    </>
  );
}

function ScheduleFields({
  draft,
  edit,
  invalid,
  onChange,
  scope,
}: Readonly<{
  draft: ScheduleDraft;
  edit: boolean;
  invalid: (field: string) => boolean;
  onChange: (draft: ScheduleDraft) => void;
  scope: EnvironmentScope;
}>) {
  return (
    <>
      <Field invalid={invalid("name")}>
        <Label>Name</Label>
        <Input
          aria-invalid={invalid("name")}
          autoComplete="off"
          name="name"
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
          value={draft.name}
        />
      </Field>
      {edit ? null : (
        <DeploymentField
          invalid={invalid("agentDeploymentId")}
          kind="schedule"
          onChange={(agentDeploymentId) => onChange({ ...draft, agentDeploymentId })}
          scope={scope}
          value={draft.agentDeploymentId}
        />
      )}
      <CadenceFields
        invalid={invalid("cadence")}
        onChange={(cadence) => onChange({ ...draft, cadence })}
        timezone={draft.timezone}
        value={draft.cadence}
      />
      <TimezoneField
        invalid={invalid("timezone")}
        onChange={(timezone) => onChange({ ...draft, timezone })}
        value={draft.timezone}
      />
      <Field invalid={invalid("prompt")}>
        <Label>Prompt</Label>
        <Description>
          The message each fire sends to the agent. Up to 40,000 characters.
        </Description>
        <Textarea
          aria-invalid={invalid("prompt")}
          name="prompt"
          onChange={(event) => onChange({ ...draft, prompt: event.target.value })}
          rows={4}
          value={draft.prompt}
        />
      </Field>
      {edit ? null : (
        <>
          <WorkspaceField
            onChange={(workspaceId) => onChange({ ...draft, workspaceId })}
            scope={scope}
            value={draft.workspaceId}
          />
          <CheckboxField>
            <Checkbox
              checked={draft.startPaused}
              name="startPaused"
              onCheckedChange={(startPaused) => onChange({ ...draft, startPaused })}
            />
            <Label>Start paused</Label>
            <Description>{START_PAUSED_NOTE}</Description>
          </CheckboxField>
        </>
      )}
    </>
  );
}

function HeartbeatFields({
  draft,
  edit,
  invalid,
  onChange,
  scope,
}: Readonly<{
  draft: HeartbeatDraft;
  edit: boolean;
  invalid: (field: string) => boolean;
  onChange: (draft: HeartbeatDraft) => void;
  scope: EnvironmentScope;
}>) {
  return (
    <>
      {edit ? null : (
        <DeploymentField
          invalid={invalid("agentDeploymentId")}
          kind="heartbeat"
          onChange={(agentDeploymentId) => onChange({ ...draft, agentDeploymentId })}
          scope={scope}
          value={draft.agentDeploymentId}
        />
      )}
      <Field invalid={invalid("intervalMinutes")}>
        <Label>Interval in minutes</Label>
        <Description>From 1 minute to 30 days (43,200 minutes).</Description>
        <Input
          aria-invalid={invalid("intervalMinutes")}
          inputMode="numeric"
          name="intervalMinutes"
          onChange={(event) => onChange({ ...draft, intervalMinutes: event.target.value })}
          value={draft.intervalMinutes}
        />
      </Field>
      <TimezoneField
        invalid={invalid("timezone")}
        onChange={(timezone) => onChange({ ...draft, timezone })}
        value={draft.timezone}
      />
      <ActiveWindowFields
        invalid={invalid("window")}
        onChange={(window) => onChange({ ...draft, window })}
        value={draft.window}
      />
      <CheckboxField>
        <Checkbox
          checked={draft.skipWhenBusy}
          name="skipWhenBusy"
          onCheckedChange={(skipWhenBusy) => onChange({ ...draft, skipWhenBusy })}
        />
        <Label>Skip while busy</Label>
        <Description>Skip a beat while the deployment already has a run in progress.</Description>
      </CheckboxField>
      <Field invalid={invalid("instructions")}>
        <Label>Instructions</Label>
        <Description>What the agent does on each beat. Up to 32,000 characters.</Description>
        <Textarea
          aria-invalid={invalid("instructions")}
          name="instructions"
          onChange={(event) => onChange({ ...draft, instructions: event.target.value })}
          rows={4}
          value={draft.instructions}
        />
      </Field>
      {edit ? null : (
        <>
          <WorkspaceField
            onChange={(workspaceId) => onChange({ ...draft, workspaceId })}
            scope={scope}
            value={draft.workspaceId}
          />
          <CheckboxField>
            <Checkbox
              checked={draft.startPaused}
              name="startPaused"
              onCheckedChange={(startPaused) => onChange({ ...draft, startPaused })}
            />
            <Label>Start paused</Label>
            <Description>{START_PAUSED_NOTE}</Description>
          </CheckboxField>
        </>
      )}
    </>
  );
}

function invalidFor(check: { readonly kind: string; readonly field?: string }) {
  return (field: string) => check.kind === "invalid" && check.field === field;
}

function ChangedNotice({ changed, children }: Readonly<{ changed: boolean; children: ReactNode }>) {
  return changed ? (
    <Callout variant="destructive">
      <CalloutTitle>{children}</CalloutTitle>
      <CalloutDescription>
        Close the form and open it again to edit the latest values.
      </CalloutDescription>
    </Callout>
  ) : null;
}

export function CreateScheduleDialog({
  onClose,
  scope,
}: Readonly<{ onClose: () => void; scope: EnvironmentScope }>) {
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const refresh = useRefresh(scope);
  const openCreated = useOpenCreated(scope);
  const [draft, setDraft] = useState(() => newScheduleDraft(BROWSER_TIME_ZONE));
  const held = useKeyedSnapshot<ScheduleDraft>();
  const check = checkScheduleCreate(draft);
  return (
    <ActionDialog<AutomationEntry>
      confirmLabel="Create schedule"
      confirmation={typedConfirmation(environment.type, { phrase: draft.name.trim() || "create" })}
      description="A schedule runs an agent deployment on a calendar or at a fixed rate."
      invalid={check.kind !== "ready"}
      onClose={onClose}
      onSuccess={(entry) => {
        void refresh();
        openCreated(entry);
      }}
      open
      run={(idempotencyKey, resend) => {
        const sent = held(idempotencyKey, resend, draft);
        const ready = checkScheduleCreate(sent);
        if (ready.kind !== "ready") throw new Error("The form is incomplete.");
        return createScheduleFn({
          data: { body: ready.body, idempotencyKey, scope, startPaused: sent.startPaused },
        });
      }}
      size="xl"
      successMessage="Schedule created"
      title="Create a schedule"
    >
      <ScheduleFields
        draft={draft}
        edit={false}
        invalid={invalidFor(check)}
        onChange={setDraft}
        scope={scope}
      />
    </ActionDialog>
  );
}

export function CreateHeartbeatDialog({
  onClose,
  scope,
}: Readonly<{ onClose: () => void; scope: EnvironmentScope }>) {
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const refresh = useRefresh(scope);
  const openCreated = useOpenCreated(scope);
  const [draft, setDraft] = useState(() => newHeartbeatDraft(BROWSER_TIME_ZONE));
  const held = useKeyedSnapshot<HeartbeatDraft>();
  const check = checkHeartbeatCreate(draft);
  return (
    <ActionDialog<AutomationEntry>
      confirmLabel="Create heartbeat"
      confirmation={typedConfirmation(environment.type, { phrase: "create" })}
      description="A heartbeat runs an agent deployment on a fixed interval, optionally only inside an active window."
      invalid={check.kind !== "ready"}
      onClose={onClose}
      onSuccess={(entry) => {
        void refresh();
        openCreated(entry);
      }}
      open
      run={(idempotencyKey, resend) => {
        const sent = held(idempotencyKey, resend, draft);
        const ready = checkHeartbeatCreate(sent);
        if (ready.kind !== "ready") throw new Error("The form is incomplete.");
        return createHeartbeatFn({
          data: { body: ready.body, idempotencyKey, scope, startPaused: sent.startPaused },
        });
      }}
      size="xl"
      successMessage="Heartbeat created"
      title="Create a heartbeat"
    >
      <HeartbeatFields
        draft={draft}
        edit={false}
        invalid={invalidFor(check)}
        onChange={setDraft}
        scope={scope}
      />
    </ActionDialog>
  );
}

export function EditScheduleDialog({
  onClose,
  open,
  schedule,
  scope,
}: Readonly<{ onClose: () => void; open: boolean; schedule: Schedule; scope: EnvironmentScope }>) {
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const refresh = useRefresh(scope);
  const [base] = useState(schedule);
  const [draft, setDraft] = useState(() => scheduleEditDraft(schedule));
  const check = checkScheduleEdit(base, draft);
  return (
    <ActionDialog<AutomationEntry>
      confirmLabel="Save changes"
      confirmation={typedConfirmation(environment.type, { phrase: base.name })}
      description="Changing the cadence or time zone re-creates the schedule's timer."
      invalid={check.kind !== "ready"}
      onClose={onClose}
      onSuccess={() => void refresh()}
      open={open}
      runOnce={() => {
        if (check.kind !== "ready") throw new Error("Nothing to save.");
        return refreshOnConflict(
          updateScheduleFn({
            data: { body: check.body, expectedVersion: base.version, id: base.id, scope },
          }),
          refresh,
        );
      }}
      size="xl"
      successMessage="Schedule updated"
      title={`Edit ${base.name}`}
    >
      <ChangedNotice changed={schedule.version !== base.version}>
        This schedule changed after you opened the form
      </ChangedNotice>
      <ScheduleFields
        draft={draft}
        edit
        invalid={invalidFor(check)}
        onChange={setDraft}
        scope={scope}
      />
    </ActionDialog>
  );
}

export function EditHeartbeatDialog({
  heartbeat,
  label,
  onClose,
  open,
  scope,
}: Readonly<{
  heartbeat: Heartbeat;
  label: string;
  onClose: () => void;
  open: boolean;
  scope: EnvironmentScope;
}>) {
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const refresh = useRefresh(scope);
  const [base] = useState(heartbeat);
  const [draft, setDraft] = useState(() => heartbeatEditDraft(heartbeat));
  const check = checkHeartbeatEdit(base, draft);
  return (
    <ActionDialog<AutomationEntry>
      confirmLabel="Save changes"
      confirmation={typedConfirmation(environment.type, { phrase: base.id.slice(-8) })}
      description="Changing the interval or time zone re-creates the heartbeat's timer."
      invalid={check.kind !== "ready"}
      onClose={onClose}
      onSuccess={() => void refresh()}
      open={open}
      runOnce={() => {
        if (check.kind !== "ready") throw new Error("Nothing to save.");
        return refreshOnConflict(
          updateHeartbeatFn({
            data: { body: check.body, expectedVersion: base.version, id: base.id, scope },
          }),
          refresh,
        );
      }}
      size="xl"
      successMessage="Heartbeat updated"
      title={`Edit ${label}`}
    >
      <ChangedNotice changed={heartbeat.version !== base.version}>
        This heartbeat changed after you opened the form
      </ChangedNotice>
      <HeartbeatFields
        draft={draft}
        edit
        invalid={invalidFor(check)}
        onChange={setDraft}
        scope={scope}
      />
    </ActionDialog>
  );
}
