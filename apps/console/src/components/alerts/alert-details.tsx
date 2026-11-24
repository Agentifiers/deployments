import {
  Archive02Icon,
  MailSend01Icon,
  NotificationOff01Icon,
  Notification01Icon,
  PencilEdit02Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { statusLabel } from "../../status.ts";
import type { ConsoleOperation } from "../../access.ts";
import {
  describeCondition,
  MONITOR_KIND_COPY,
  monitorActions,
  monitorState,
  ROLE_LABELS,
  type AlertIncident,
  type MonitorAction,
} from "../../alerts/monitor-model.ts";
import { incidentPagesQuery, incidentQuery, monitorQuery } from "../../data/alert-queries.ts";
import { organizationShellQuery } from "../../data/console-queries.ts";
import { memberDirectoryQuery } from "../../data/membership-queries.ts";
import { memberName } from "../../members/roles.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { Heading, Subheading } from "@/components/ui/heading";
import { Link } from "@/components/ui/link";
import { Text } from "@/components/ui/text";
import {
  Timeline,
  TimelineContent,
  TimelineHeader,
  TimelineIndicator,
  TimelineItem,
  TimelineSeparator,
} from "../reui/timeline.tsx";
import { Icon } from "../icon.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { SectionBoundary } from "../section-boundary.tsx";
import { ALERT_STATE_COLORS, AlertScopeLabel, incidentHref, monitorHref } from "./alert-lists.tsx";
import { EditMonitorDialog, MonitorActionDialog, MuteMonitorDialog } from "./monitor-dialogs.tsx";

const ACTION_CONTROLS: Readonly<
  Record<
    MonitorAction,
    { readonly icon: IconSvgElement; readonly label: string; readonly operation: ConsoleOperation }
  >
> = {
  archive: { icon: Archive02Icon, label: "Archive", operation: "archiveMonitor" },
  edit: { icon: PencilEdit02Icon, label: "Edit", operation: "updateMonitor" },
  mute: { icon: NotificationOff01Icon, label: "Mute", operation: "updateMonitor" },
  test: { icon: MailSend01Icon, label: "Send test", operation: "testMonitor" },
  unmute: { icon: Notification01Icon, label: "Unmute", operation: "updateMonitor" },
};

function Recipients({
  emailPrincipalIds,
  organizationId,
}: Readonly<{ emailPrincipalIds: readonly string[]; organizationId: string }>) {
  const { data: members } = useSuspenseQuery(memberDirectoryQuery(organizationId));
  const names = new Map<string, string>(
    members.map((member) => [member.principalId, memberName(member)]),
  );
  return (
    <ul className="flex flex-col gap-1">
      {emailPrincipalIds.map((id) => (
        <li key={id}>{names.get(id) ?? <PublicId value={id} />}</li>
      ))}
    </ul>
  );
}

export function MonitorDetail({
  monitorId,
  organizationId,
}: Readonly<{ monitorId: string; organizationId: string }>) {
  const { data: shell } = useSuspenseQuery(organizationShellQuery(organizationId));
  const { data: monitor } = useSuspenseQuery(monitorQuery(organizationId, monitorId));
  const [dialog, setDialog] = useState<MonitorAction>();
  const now = new Date();
  const state = monitorState(monitor, now);
  const actions = monitorActions(monitor, now).filter(
    (action) => shell.access[ACTION_CONTROLS[action].operation],
  );
  const close = () => setDialog(undefined);
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <Heading level={2}>{monitor.name}</Heading>
        <Badge color={ALERT_STATE_COLORS[state]}>{statusLabel(state)}</Badge>
        <div className="ml-auto flex flex-wrap gap-3">
          {actions.map((action) => {
            const { icon, label } = ACTION_CONTROLS[action];
            return (
              <Button
                key={action}
                onClick={() => setDialog(action)}
                variant={action === "archive" ? "destructive" : "outline"}
              >
                <Icon icon={icon} />
                {label}
              </Button>
            );
          })}
        </div>
      </div>
      {shell.access.updateMonitor ? null : <Text>Owners and admins can change monitors.</Text>}
      <DescriptionList>
        <DescriptionTerm>Watches</DescriptionTerm>
        <DescriptionDetails>{MONITOR_KIND_COPY[monitor.condition.kind].label}</DescriptionDetails>
        <DescriptionTerm>Condition</DescriptionTerm>
        <DescriptionDetails>{describeCondition(monitor.condition)}</DescriptionDetails>
        <DescriptionTerm>Where</DescriptionTerm>
        <DescriptionDetails>
          <AlertScopeLabel item={monitor} projects={shell.projects} />
        </DescriptionDetails>
        <DescriptionTerm>Email</DescriptionTerm>
        <DescriptionDetails>
          {monitor.notify.emailRoles.length === 0 && monitor.notify.emailPrincipalIds.length === 0
            ? "Nobody"
            : monitor.notify.emailRoles.map((role) => ROLE_LABELS[role]).join(", ") || null}
          {monitor.notify.emailPrincipalIds.length > 0 ? (
            <SectionBoundary resetKey={monitor.id}>
              <Recipients
                emailPrincipalIds={monitor.notify.emailPrincipalIds}
                organizationId={organizationId}
              />
            </SectionBoundary>
          ) : null}
        </DescriptionDetails>
        <DescriptionTerm>Webhook events</DescriptionTerm>
        <DescriptionDetails>{monitor.notify.webhooks ? "Sent" : "Not sent"}</DescriptionDetails>
        <DescriptionTerm>While firing</DescriptionTerm>
        <DescriptionDetails>
          {monitor.renotifyMinutes === undefined
            ? "Alert once per incident"
            : `Repeat every ${monitor.renotifyMinutes} minutes`}
        </DescriptionDetails>
        {monitor.status === "muted" ? (
          <>
            <DescriptionTerm>Muted until</DescriptionTerm>
            <DescriptionDetails>
              {monitor.mutedUntil ? <Timestamp value={monitor.mutedUntil} /> : "Unmuted by hand"}
            </DescriptionDetails>
          </>
        ) : null}
        <DescriptionTerm>ID</DescriptionTerm>
        <DescriptionDetails>
          <PublicId value={monitor.id} />
        </DescriptionDetails>
        <DescriptionTerm>Updated</DescriptionTerm>
        <DescriptionDetails>
          <Timestamp value={monitor.updatedAt} />
        </DescriptionDetails>
      </DescriptionList>
      <section className="flex flex-col gap-3">
        <Subheading>Recent incidents</Subheading>
        <SectionBoundary resetKey={monitor.id}>
          <MonitorIncidents monitorId={monitor.id} organizationId={organizationId} />
        </SectionBoundary>
      </section>
      {dialog === "edit" ? <EditMonitorDialog monitor={monitor} onClose={close} open /> : null}
      {dialog === "mute" ? <MuteMonitorDialog monitor={monitor} onClose={close} open /> : null}
      {dialog === "archive" || dialog === "test" || dialog === "unmute" ? (
        <MonitorActionDialog action={dialog} monitor={monitor} onClose={close} open />
      ) : null}
    </div>
  );
}

/** This monitor's incidents among the organization's newest ones. */
function MonitorIncidents({
  monitorId,
  organizationId,
}: Readonly<{ monitorId: string; organizationId: string }>) {
  const { data } = useSuspenseInfiniteQuery(incidentPagesQuery({ organizationId }));
  const incidents = data.pages
    .flatMap((page) => page.items)
    .filter((incident) => incident.monitorId === monitorId);
  if (incidents.length === 0) return <Text>No recent incidents.</Text>;
  return (
    <ul className="flex flex-col gap-2">
      {incidents.map((incident) => (
        <li className="flex flex-wrap items-center gap-2 text-sm" key={incident.id}>
          <Badge color={ALERT_STATE_COLORS[incident.status]}>{statusLabel(incident.status)}</Badge>
          <Link href={incidentHref(incident)}>{incident.summary}</Link>
          <span className="text-muted-foreground">
            <Timestamp value={incident.openedAt} />
          </span>
        </li>
      ))}
    </ul>
  );
}

const RESOLUTION_TEXT: Readonly<Record<NonNullable<AlertIncident["resolution"]>, string>> = {
  "condition-cleared": "The condition cleared.",
  "monitor-archived": "The monitor was archived.",
  "monitor-changed": "The monitor was changed.",
};

const ENTRY_TITLES = { fired: "Fired", renotified: "Repeated", resolved: "Resolved" } as const;

export function IncidentDetail({
  incidentId,
  monitorId,
  organizationId,
}: Readonly<{ incidentId: string; monitorId: string; organizationId: string }>) {
  const { data: shell } = useSuspenseQuery(organizationShellQuery(organizationId));
  const { data: incident } = useSuspenseQuery(incidentQuery(organizationId, monitorId, incidentId));
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <Heading level={2}>{incident.monitorName}</Heading>
        <Badge color={ALERT_STATE_COLORS[incident.status]}>{statusLabel(incident.status)}</Badge>
      </div>
      <Text>{incident.summary}</Text>
      <DescriptionList>
        <DescriptionTerm>Monitor</DescriptionTerm>
        <DescriptionDetails>
          <Link
            href={monitorHref({ id: incident.monitorId, organizationId: incident.organizationId })}
          >
            {incident.monitorName}
          </Link>{" "}
          <span className="text-muted-foreground">· {MONITOR_KIND_COPY[incident.kind].label}</span>
        </DescriptionDetails>
        <DescriptionTerm>Where</DescriptionTerm>
        <DescriptionDetails>
          <AlertScopeLabel item={incident} projects={shell.projects} />
        </DescriptionDetails>
        <DescriptionTerm>Opened</DescriptionTerm>
        <DescriptionDetails>
          <Timestamp value={incident.openedAt} />
        </DescriptionDetails>
        <DescriptionTerm>Resolved</DescriptionTerm>
        <DescriptionDetails>
          {incident.resolvedAt ? (
            <>
              <Timestamp value={incident.resolvedAt} />
              {incident.resolution ? ` · ${RESOLUTION_TEXT[incident.resolution]}` : null}
            </>
          ) : (
            "Still firing"
          )}
        </DescriptionDetails>
        <DescriptionTerm>ID</DescriptionTerm>
        <DescriptionDetails>
          <PublicId value={incident.id} />
        </DescriptionDetails>
      </DescriptionList>
      <section className="flex flex-col gap-3">
        <Subheading>Timeline</Subheading>
        <Timeline aria-label="Incident timeline" render={<ol />} value={incident.timeline.length}>
          {incident.timeline.map((entry, index) => (
            <TimelineItem key={`${entry.type}-${entry.at}`} render={<li />} step={index + 1}>
              <TimelineHeader>
                <TimelineSeparator />
                <TimelineIndicator />
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{ENTRY_TITLES[entry.type]}</span>
                  <span className="text-muted-foreground">
                    {entry.notified ? "Recipients notified" : "Nobody notified"}
                  </span>
                </div>
              </TimelineHeader>
              <TimelineContent className="text-xs">
                <Timestamp value={entry.at} /> · {entry.summary}
              </TimelineContent>
            </TimelineItem>
          ))}
        </Timeline>
      </section>
    </div>
  );
}
