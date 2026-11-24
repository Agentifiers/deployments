import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { threadQuery } from "../../data/runtime-queries.ts";
import type { AgentLabels } from "../../observability/agent-labels.ts";
import type { Run } from "../../server/runtime-data.ts";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHead,
  TableRow,
} from "@/components/ui/table";
import { Code, TextLink } from "@/components/ui/text";
import { Timestamp } from "../observability/panels.tsx";
import { StatusBadge } from "@/components/status-badge";

export type RunLabels = Pick<AgentLabels, "deployment" | "release" | "releaseNumber">;

export interface AutomationLink {
  readonly href: string;
  readonly label: string;
}

/** The run's trigger, followed by a link to the schedule or heartbeat that fired it. */
export function RunTrigger({
  link,
  trigger,
}: Readonly<{ link: AutomationLink | undefined; trigger: string }>) {
  if (link === undefined) return trigger;
  return (
    <>
      {trigger} · <TextLink href={link.href}>{link.label}</TextLink>
    </>
  );
}

const THREAD_TITLE_STALE_MS = 60_000;

/**
 * The run's thread by title, read from the thread itself because a run carries only the ID.
 * Until the title loads, and for an untitled or unreadable thread, it shows the ID's tail.
 */
function ThreadCell({ environmentPath, run }: Readonly<{ environmentPath: string; run: Run }>) {
  const { data: thread } = useQuery({
    ...threadQuery(
      {
        environmentId: run.environmentId,
        organizationId: run.organizationId,
        projectId: run.projectId,
      },
      run.threadId,
    ),
    retry: false,
    staleTime: THREAD_TITLE_STALE_MS,
  });
  const title = thread?.title.trim();
  return (
    <TextLink
      className="block max-w-24 truncate"
      href={`${environmentPath}/threads/${run.threadId}?run=${run.id}`}
      title={title ? `${title} (thread ${run.threadId})` : `Thread ${run.threadId}`}
    >
      {title || <Code>…{run.threadId.slice(-8)}</Code>}
    </TextLink>
  );
}

export function RuntimeRunTable({
  automationLinks,
  environmentPath,
  focusRunId,
  labels,
  runs,
}: Readonly<{
  /** Keyed by automation ID. */
  automationLinks?: ReadonlyMap<string, AutomationLink> | undefined;
  environmentPath: string;
  focusRunId?: string | undefined;
  labels: RunLabels;
  runs: readonly Run[];
}>) {
  const unique = useMemo(() => [...new Map(runs.map((run) => [run.id, run])).values()], [runs]);
  return (
    <Table striped>
      <TableHeader>
        <TableRow>
          <TableHead>Run</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Deployment</TableHead>
          <TableHead>Release</TableHead>
          <TableHead>Purpose</TableHead>
          <TableHead>Trigger</TableHead>
          <TableHead>Thread</TableHead>
          <TableHead>Created</TableHead>
          <TableHead>Updated</TableHead>
          <TableHead className="text-right">Attempt</TableHead>
          <TableHead>Trace</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {unique.map((run) => {
          const automationLink = run.automation && automationLinks?.get(run.automation.id);
          return (
            <TableRow key={run.id}>
              <TableCell className="whitespace-nowrap">
                <TextLink href={`${environmentPath}/runs/${run.id}`} title={`Run ${run.id}`}>
                  <Code>…{run.id.slice(-8)}</Code>
                </TextLink>
                {run.id === focusRunId ? (
                  <Badge className="ml-2" color="amber">
                    this run
                  </Badge>
                ) : null}
              </TableCell>
              <TableCell>
                <StatusBadge status={run.status} />
              </TableCell>
              <TableCell className="max-w-48 truncate">
                {run.agentDeploymentId ? labels.deployment(run.agentDeploymentId) : "—"}
              </TableCell>
              <TableCell className="whitespace-nowrap">
                {run.agentReleaseId === undefined
                  ? "—"
                  : run.agentDeploymentId
                    ? labels.releaseNumber(run.agentReleaseId)
                    : labels.release(run.agentReleaseId)}
                {run.releaseSelection === "candidate" ? (
                  <Badge className="ml-2" color="amber">
                    canary
                  </Badge>
                ) : null}
              </TableCell>
              <TableCell>{run.executionPurpose}</TableCell>
              <TableCell
                className="max-w-48 truncate"
                title={automationLink ? `${run.trigger} · ${automationLink.label}` : run.trigger}
              >
                <RunTrigger link={automationLink} trigger={run.trigger} />
              </TableCell>
              <TableCell>
                <ThreadCell environmentPath={environmentPath} run={run} />
              </TableCell>
              <TableCell className="whitespace-nowrap">
                <Timestamp value={run.createdAt} />
              </TableCell>
              <TableCell className="whitespace-nowrap">
                <Timestamp value={run.updatedAt} />
              </TableCell>
              <TableCell className="text-right tabular-nums">{run.attempt}</TableCell>
              <TableCell>
                <TextLink
                  href={`${environmentPath}/traces/${encodeURIComponent(run.traceId)}`}
                  title={`Trace ${run.traceId}`}
                >
                  Trace
                </TextLink>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
