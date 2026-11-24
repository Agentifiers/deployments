import { useSuspenseQuery } from "@tanstack/react-query";
import { systemAlarmsQuery, systemComponentsQuery } from "../../data/system-queries.ts";
import type { SystemAlarm } from "../../server/system-data.ts";
import { statusLabel, type BadgeColor } from "../../status.ts";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Code, Text } from "@/components/ui/text";
import { Timestamp } from "../observability/panels.tsx";
import { StatusBadge } from "@/components/status-badge";

const ALARM_COLORS: Readonly<Record<SystemAlarm["state"], BadgeColor>> = {
  ALARM: "red",
  INSUFFICIENT_DATA: "amber",
  OK: "green",
};

const count = (value: number | null) => (value === null ? "?" : String(value));

export function SystemComponents() {
  const { data: components } = useSuspenseQuery(systemComponentsQuery());
  return (
    <div className="flex flex-col gap-6">
      <Text>
        Checked <Timestamp value={components.checkedAt} />.
      </Text>
      <Table dense striped>
        <TableHeader>
          <TableRow>
            <TableHead>ECS service</TableHead>
            <TableHead>Health</TableHead>
            <TableHead className="text-right">Running / desired</TableHead>
            <TableHead>Rollout</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {components.ecsServices.map((service) => (
            <TableRow key={`${service.clusterName}/${service.serviceName}`}>
              <TableCell>
                <div className="font-medium">{service.component}</div>
                <Code>{service.serviceName}</Code>
              </TableCell>
              <TableCell>
                <StatusBadge status={service.health} />
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {count(service.runningCount)} / {count(service.desiredCount)}
                {service.pendingCount ? ` (${service.pendingCount} pending)` : ""}
              </TableCell>
              <TableCell>
                {service.rolloutState ?? service.status ?? "—"}
                {service.rolloutStateReason ? (
                  <div className="text-xs text-muted-foreground">{service.rolloutStateReason}</div>
                ) : null}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Table dense striped>
        <TableHeader>
          <TableRow>
            <TableHead>Lambda function</TableHead>
            <TableHead>Health</TableHead>
            <TableHead>State</TableHead>
            <TableHead>Code</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {components.lambdaFunctions.map((lambda) => (
            <TableRow key={lambda.functionName}>
              <TableCell>
                <div className="font-medium">{lambda.artifact}</div>
                <Code>{lambda.functionName}</Code>
              </TableCell>
              <TableCell>
                <StatusBadge status={lambda.health} />
              </TableCell>
              <TableCell>
                {lambda.state ?? "—"}
                {lambda.lastUpdateStatus ? ` · ${lambda.lastUpdateStatus}` : ""}
              </TableCell>
              <TableCell>
                {lambda.codeMatchesRelease === null
                  ? "Not compared"
                  : lambda.codeMatchesRelease
                    ? "Matches the release"
                    : "Differs from the release"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** Alarms arrive firing first, so an alarm in ALARM is always at the top. */
export function SystemAlarms() {
  const { data: alarms } = useSuspenseQuery(systemAlarmsQuery());
  if (alarms.length === 0) return <Text>No CloudWatch alarms match the install's prefix.</Text>;
  return (
    <Table dense striped>
      <TableHeader>
        <TableRow>
          <TableHead>Alarm</TableHead>
          <TableHead>State</TableHead>
          <TableHead>Metric</TableHead>
          <TableHead>Updated</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {alarms.map((alarm) => (
          <TableRow key={alarm.name}>
            <TableCell>
              <div className="font-medium">{alarm.name}</div>
              {alarm.reason ? (
                <div className="max-w-xl text-xs whitespace-normal text-muted-foreground">
                  {alarm.reason}
                </div>
              ) : null}
            </TableCell>
            <TableCell>
              <Badge color={ALARM_COLORS[alarm.state]}>{statusLabel(alarm.state)}</Badge>
            </TableCell>
            <TableCell>
              {alarm.namespace && alarm.metricName ? (
                <Code>
                  {alarm.namespace}/{alarm.metricName}
                </Code>
              ) : (
                "—"
              )}
            </TableCell>
            <TableCell className="whitespace-nowrap">
              {alarm.updatedAt ? <Timestamp value={alarm.updatedAt} /> : "—"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
