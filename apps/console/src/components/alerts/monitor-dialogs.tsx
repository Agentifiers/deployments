import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  checkCreate,
  checkUpdate,
  monitorDraft,
  MUTE_CHOICES,
  muteBody,
  newMonitorDraft,
  type Monitor,
  type MonitorDraft,
} from "../../alerts/monitor-model.ts";
import {
  archiveMonitorFn,
  createMonitorFn,
  testMonitorFn,
  updateMonitorFn,
} from "../../data/alert-mutations.ts";
import { invalidateAlerts } from "../../data/alert-queries.ts";
import { organizationShellQuery } from "../../data/console-queries.ts";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import { Description, Field, Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { ActionDialog, refreshOnConflict } from "../action-dialog.tsx";
import { useKeyedSnapshot } from "../keyed-snapshot.ts";
import {
  ConditionFields,
  EnvironmentField,
  KindField,
  NotifyFields,
  projectOfEnvironment,
} from "./monitor-form.tsx";

function NameField({
  draft,
  onChange,
}: Readonly<{ draft: MonitorDraft; onChange: (draft: MonitorDraft) => void }>) {
  return (
    <Field>
      <Label>Name</Label>
      <Input
        name="name"
        onChange={(event) => onChange({ ...draft, name: event.target.value })}
        placeholder="Checkout runs failing"
        value={draft.name}
      />
    </Field>
  );
}

export function CreateMonitorDialog({
  environmentId,
  onClose,
  open,
  organizationId,
}: Readonly<{
  /** Preselected environment, when opened from inside one. */
  environmentId?: string;
  onClose: () => void;
  open: boolean;
  organizationId: string;
}>) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: shell } = useSuspenseQuery(organizationShellQuery(organizationId));
  const [draft, setDraft] = useState(() => newMonitorDraft("run-failures", environmentId ?? ""));
  const held = useKeyedSnapshot<MonitorDraft>();
  useEffect(() => {
    if (open) setDraft(newMonitorDraft("run-failures", environmentId ?? ""));
  }, [open]);
  const projectOf = (id: string) => projectOfEnvironment(shell.projects, id);
  const check = checkCreate(draft, projectOf);
  return (
    <ActionDialog<Monitor>
      confirmLabel="Create monitor"
      description="A monitor opens one incident when its condition starts to hold, tells the recipients once, and sends one all-clear when it clears."
      invalid={!check.ok}
      onClose={onClose}
      onSuccess={(monitor) => {
        void invalidateAlerts(queryClient, organizationId);
        void navigate({
          params: { monitorId: monitor.id, orgId: organizationId },
          to: "/o/$orgId/alerts/monitors/$monitorId",
        });
      }}
      open={open}
      run={(idempotencyKey, resend) => {
        const sent = checkCreate(held(idempotencyKey, resend, draft), projectOf);
        if (!sent.ok) throw new TypeError(sent.message);
        return createMonitorFn({
          data: { body: sent.body, idempotencyKey, scope: { organizationId } },
        });
      }}
      size="xl"
      successMessage="Monitor created"
      title="Create monitor"
    >
      <NameField draft={draft} onChange={setDraft} />
      <KindField draft={draft} onChange={setDraft} />
      <EnvironmentField draft={draft} onChange={setDraft} projects={shell.projects} />
      <ConditionFields draft={draft} onChange={setDraft} />
      <NotifyFields draft={draft} onChange={setDraft} open={open} organizationId={organizationId} />
    </ActionDialog>
  );
}

export function EditMonitorDialog({
  monitor,
  onClose,
  open,
}: Readonly<{ monitor: Monitor; onClose: () => void; open: boolean }>) {
  const queryClient = useQueryClient();
  const [base, setBase] = useState(monitor);
  const [draft, setDraft] = useState(() => monitorDraft(monitor));
  const held = useKeyedSnapshot<MonitorDraft>();
  useEffect(() => {
    if (!open) return;
    setBase(monitor);
    setDraft(monitorDraft(monitor));
  }, [open]);
  const check = checkUpdate(base, draft);
  const refresh = () => invalidateAlerts(queryClient, monitor.organizationId);
  return (
    <ActionDialog
      confirmLabel="Save changes"
      description="Changing the condition re-evaluates the monitor. To watch a different kind of signal, create a new monitor."
      invalid={!check.ok}
      onClose={onClose}
      onSuccess={() => void refresh()}
      open={open}
      run={(idempotencyKey, resend) => {
        const sent = checkUpdate(base, held(idempotencyKey, resend, draft));
        if (!sent.ok) throw new TypeError(sent.message);
        return refreshOnConflict(
          updateMonitorFn({
            data: {
              body: sent.body,
              idempotencyKey,
              monitorId: monitor.id,
              scope: { organizationId: monitor.organizationId },
            },
          }),
          refresh,
        );
      }}
      size="xl"
      successMessage="Monitor updated"
      title={`Edit ${base.name}`}
    >
      <NameField draft={draft} onChange={setDraft} />
      <ConditionFields draft={draft} onChange={setDraft} />
      <NotifyFields
        draft={draft}
        onChange={setDraft}
        open={open}
        organizationId={monitor.organizationId}
      />
    </ActionDialog>
  );
}

export function MuteMonitorDialog({
  monitor,
  onClose,
  open,
}: Readonly<{ monitor: Monitor; onClose: () => void; open: boolean }>) {
  const queryClient = useQueryClient();
  const [hours, setHours] = useState<number | undefined>(MUTE_CHOICES[0].hours);
  const held = useKeyedSnapshot<number | undefined>();
  const refresh = () => invalidateAlerts(queryClient, monitor.organizationId);
  return (
    <ActionDialog
      confirmLabel="Mute monitor"
      description="A muted monitor still opens and resolves incidents, so its history stays complete, but it emails nobody and sends no webhook events."
      onClose={onClose}
      onSuccess={() => void refresh()}
      open={open}
      run={(idempotencyKey, resend) =>
        refreshOnConflict(
          updateMonitorFn({
            data: {
              body: muteBody(held(idempotencyKey, resend, hours), new Date()),
              idempotencyKey,
              monitorId: monitor.id,
              scope: { organizationId: monitor.organizationId },
            },
          }),
          refresh,
        )
      }
      successMessage="Monitor muted"
      title={`Mute ${monitor.name}?`}
    >
      <Field>
        <Label>How long</Label>
        <NativeSelect
          onChange={(event) =>
            setHours(
              MUTE_CHOICES.find((choice) => String(choice.hours) === event.target.value)?.hours,
            )
          }
          value={String(hours)}
        >
          {MUTE_CHOICES.map((choice) => (
            <option key={choice.label} value={String(choice.hours)}>
              {choice.label}
            </option>
          ))}
        </NativeSelect>
      </Field>
    </ActionDialog>
  );
}

const SIMPLE_ACTIONS = {
  archive: {
    confirmLabel: "Archive monitor",
    description:
      "Archiving resolves any open incident without an email and stops the monitor for good. Its incidents stay readable.",
    destructive: true,
    successMessage: "Monitor archived",
    verb: "Archive",
  },
  test: {
    confirmLabel: "Send test",
    description:
      "Sends one test alert email to you and, if the monitor sends webhook events, one alert.test event. It opens no incident.",
    destructive: false,
    successMessage: "Test alert sent",
    verb: "Test",
  },
  unmute: {
    confirmLabel: "Unmute monitor",
    description:
      "The monitor notifies its recipients again. An incident that is open now is not re-sent until it repeats or resolves.",
    destructive: false,
    successMessage: "Monitor unmuted",
    verb: "Unmute",
  },
} as const;

export type SimpleMonitorAction = keyof typeof SIMPLE_ACTIONS;

export function MonitorActionDialog({
  action,
  monitor,
  onClose,
  open,
}: Readonly<{
  action: SimpleMonitorAction;
  monitor: Monitor;
  onClose: () => void;
  open: boolean;
}>) {
  const queryClient = useQueryClient();
  const copy = SIMPLE_ACTIONS[action];
  const refresh = () => invalidateAlerts(queryClient, monitor.organizationId);
  return (
    <ActionDialog<unknown>
      confirmLabel={copy.confirmLabel}
      description={copy.description}
      destructive={copy.destructive}
      onClose={onClose}
      onSuccess={() => void refresh()}
      open={open}
      run={(idempotencyKey) => {
        const data = {
          idempotencyKey,
          monitorId: monitor.id,
          scope: { organizationId: monitor.organizationId },
        };
        switch (action) {
          case "archive":
            return refreshOnConflict(archiveMonitorFn({ data }), refresh);
          case "test":
            return testMonitorFn({ data });
          case "unmute":
            return refreshOnConflict(
              updateMonitorFn({ data: { ...data, body: { mute: null } } }),
              refresh,
            );
        }
      }}
      successMessage={copy.successMessage}
      title={`${copy.verb} ${monitor.name}?`}
    >
      {action === "test" && !monitor.notify.webhooks ? (
        <Description>
          This monitor does not send webhook events, so only the email is sent.
        </Description>
      ) : null}
      {action === "archive" && monitor.state === "firing" ? (
        <Callout>
          <CalloutTitle>This monitor is firing</CalloutTitle>
          <CalloutDescription>
            Its open incident resolves now, and nobody is told it cleared.
          </CalloutDescription>
        </Callout>
      ) : null}
    </ActionDialog>
  );
}
