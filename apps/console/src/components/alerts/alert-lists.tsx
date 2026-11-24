import { Notification01Icon, SirenIcon } from "@hugeicons/core-free-icons";
import { useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { statusLabel } from "../../status.ts";
import {
  describeCondition,
  MONITOR_KIND_COPY,
  monitorState,
  ROLE_LABELS,
  type AlertIncident,
  type Monitor,
} from "../../alerts/monitor-model.ts";
import {
  incidentPagesQuery,
  monitorPagesQuery,
  type AlertListScope,
} from "../../data/alert-queries.ts";
import { organizationShellQuery } from "../../data/console-queries.ts";
import type { OrganizationShell } from "../../server/console-data.ts";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ListEmpty, LoadMore } from "../list-controls.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";

export const ALERT_STATE_COLORS = {
  archived: "zinc",
  firing: "red",
  muted: "amber",
  ok: "green",
  resolved: "green",
} as const;

/** Where a monitor or incident belongs: the organization, or one project's environment. */
export function AlertScopeLabel({
  item,
  projects,
}: Readonly<{
  item: { readonly environmentId?: string | undefined; readonly projectId?: string | undefined };
  projects: OrganizationShell["projects"];
}>) {
  if (item.environmentId === undefined) return "Organization";
  const entry = projects.find(({ project }) => project.id === item.projectId);
  const environment = entry?.environments.find(({ id }) => id === item.environmentId);
  return entry && environment ? (
    `${entry.project.name} / ${environment.name}`
  ) : (
    <>
      Environment <PublicId value={item.environmentId} />
    </>
  );
}

export const incidentHref = (incident: AlertIncident) =>
  `/o/${incident.organizationId}/alerts/incidents/${incident.monitorId}/${incident.id}`;

export const monitorHref = (monitor: Pick<Monitor, "id" | "organizationId">) =>
  `/o/${monitor.organizationId}/alerts/monitors/${monitor.id}`;

/** Alert incidents, newest first: what fired, where, and whether it has resolved. */
export function IncidentList({ list }: Readonly<{ list: AlertListScope }>) {
  const { data: shell } = useSuspenseQuery(organizationShellQuery(list.organizationId));
  const pagesQuery = incidentPagesQuery(list);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(pagesQuery);
  const incidents = data.pages.flatMap((page) => page.items);
  return (
    <div className="flex flex-col gap-4">
      {incidents.length === 0 ? (
        <ListEmpty docs="/docs/capabilities/alerts" icon={SirenIcon} title="No alerts yet">
          When a monitor&apos;s condition starts to hold, its incident appears here with a timeline
          of who was told and when it resolved.
        </ListEmpty>
      ) : (
        <Table striped>
          <TableHeader>
            <TableRow>
              <TableHead>Status</TableHead>
              <TableHead>Monitor</TableHead>
              <TableHead>What happened</TableHead>
              <TableHead>Where</TableHead>
              <TableHead>Opened</TableHead>
              <TableHead>Resolved</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {incidents.map((incident) => (
              <TableRow
                href={incidentHref(incident)}
                key={incident.id}
                title={incident.monitorName}
              >
                <TableCell>
                  <Badge color={ALERT_STATE_COLORS[incident.status]}>
                    {statusLabel(incident.status)}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="flex flex-col">
                    <span>{incident.monitorName}</span>
                    <span className="text-xs text-muted-foreground">
                      {MONITOR_KIND_COPY[incident.kind].label}
                    </span>
                  </div>
                </TableCell>
                <TableCell className="max-w-md whitespace-normal">{incident.summary}</TableCell>
                <TableCell>
                  <AlertScopeLabel item={incident} projects={shell.projects} />
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <Timestamp value={incident.openedAt} />
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {incident.resolvedAt ? <Timestamp value={incident.resolvedAt} /> : "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <LoadMore
        error={error}
        fetchNextPage={fetchNextPage}
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        queryKey={pagesQuery.queryKey}
      />
    </div>
  );
}

function recipients(monitor: Monitor) {
  const parts = [
    ...(monitor.notify.emailRoles.length > 0
      ? [monitor.notify.emailRoles.map((role) => ROLE_LABELS[role]).join(", ")]
      : []),
    ...(monitor.notify.emailPrincipalIds.length > 0
      ? [
          `${monitor.notify.emailPrincipalIds.length} named member${
            monitor.notify.emailPrincipalIds.length === 1 ? "" : "s"
          }`,
        ]
      : []),
    ...(monitor.notify.webhooks ? ["Webhooks"] : []),
  ];
  return parts.length === 0 ? "Nobody" : parts.join(" · ");
}

/** The organization's monitors, or one environment's, newest first, with their current state. */
export function MonitorList({
  createAction,
  list,
}: Readonly<{ createAction?: ReactNode; list: AlertListScope }>) {
  const { data: shell } = useSuspenseQuery(organizationShellQuery(list.organizationId));
  const pagesQuery = monitorPagesQuery(list);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(pagesQuery);
  const monitors = data.pages.flatMap((page) => page.items);
  const now = new Date();
  return (
    <div className="flex flex-col gap-4">
      {monitors.length === 0 ? (
        <ListEmpty
          action={createAction}
          docs="/docs/capabilities/alerts"
          icon={Notification01Icon}
          title="No monitors"
        >
          A monitor watches failed runs and tools, waiting approvals, schedules, webhook endpoints,
          spend, or trace metrics, and emails members when something needs attention.
        </ListEmpty>
      ) : (
        <Table striped>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Condition</TableHead>
              <TableHead>Where</TableHead>
              <TableHead>Notifies</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {monitors.map((monitor) => {
              const state = monitorState(monitor, now);
              return (
                <TableRow href={monitorHref(monitor)} key={monitor.id} title={monitor.name}>
                  <TableCell>
                    <div className="flex flex-col">
                      <span>{monitor.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {MONITOR_KIND_COPY[monitor.condition.kind].label}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge color={ALERT_STATE_COLORS[state]}>{statusLabel(state)}</Badge>
                  </TableCell>
                  <TableCell>{describeCondition(monitor.condition)}</TableCell>
                  <TableCell>
                    <AlertScopeLabel item={monitor} projects={shell.projects} />
                  </TableCell>
                  <TableCell>{recipients(monitor)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      <LoadMore
        error={error}
        fetchNextPage={fetchNextPage}
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        queryKey={pagesQuery.queryKey}
      />
    </div>
  );
}
