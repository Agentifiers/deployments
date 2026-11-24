import {
  AUTOMATION_KINDS,
  automationPath,
  type AutomationHealth,
  type AutomationKind,
  type AutomationOrigin,
  type AutomationRow,
  type LastFire,
  type NextFire,
  type ThreadBinding,
} from "../../automations/automation-state.ts";
import { describeCadence } from "../../automations/cadence.ts";
import type { AgentLabels } from "../../observability/agent-labels.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
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
import { PublicId } from "../public-id.tsx";
import { StatusBadge } from "@/components/status-badge";

const NO_NEXT_FIRE: Readonly<Record<Extract<NextFire, { kind: "none" }>["reason"], string>> = {
  "beyond-horizon": "None in the next 5 years",
  inactive: "—",
  passed: "No future fire",
  unparsed: "Not computed",
};

const CALLER_LABELS: Readonly<
  Record<Extract<AutomationOrigin, { kind: "caller" }>["actorType"], string>
> = {
  agent: "agent",
  principal: "API · principal",
  "service-account": "API · service account",
  system: "system",
  worker: "worker",
};

const SECOND_LINE = "text-xs/5 text-muted-foreground";

export function KindBadge({ kind }: Readonly<{ kind: AutomationKind }>) {
  return <Badge>{AUTOMATION_KINDS[kind].label}</Badge>;
}

export function HealthBadge({ health }: Readonly<{ health: AutomationHealth }>) {
  switch (health.kind) {
    case "ok":
      return null;
    case "stuck-provisioning":
      return (
        <Badge color="amber" title={`Provisioning since ${health.since}`}>
          stuck provisioning
        </Badge>
      );
    case "missed-fire":
      return (
        <Badge color="red" title={`A fire was expected at ${health.expectedAt}`}>
          missed fire
        </Badge>
      );
    case "last-fire-without-run":
      return (
        <Badge color="amber" title={`The fire at ${health.at} started no run`}>
          last fire started no run
        </Badge>
      );
  }
}

/** Short local date and time with the instant in the tooltip; the server renders in UTC. */
function CompactTime({ value }: Readonly<{ value: string }>) {
  return (
    <time dateTime={value} suppressHydrationWarning title={value}>
      {new Date(value).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}
    </time>
  );
}

/** `compact`: the table's short time; elsewhere the full local time. */
export function NextFireText({
  compact = false,
  nextFire,
}: Readonly<{ compact?: boolean; nextFire: NextFire }>) {
  if (nextFire.kind === "none") return NO_NEXT_FIRE[nextFire.reason];
  return (
    <>
      {nextFire.estimate ? <span title="Estimated">≈ </span> : null}
      {compact ? <CompactTime value={nextFire.at} /> : <Timestamp value={nextFire.at} />}
    </>
  );
}

/** `compact`: the table's short time, with the badge on its own line. */
export function LastFireText({
  compact = false,
  lastFire,
}: Readonly<{ compact?: boolean; lastFire: LastFire }>) {
  switch (lastFire.kind) {
    case "never":
      return "Never";
    case "unavailable":
      return <span title="The last fire could not be read">Unavailable</span>;
    case "fired": {
      const { fire } = lastFire;
      return (
        <span className={compact ? "flex flex-col items-start gap-1" : undefined}>
          {compact ? <CompactTime value={fire.at} /> : <Timestamp value={fire.at} />}
          {fire.outcome === "started" ? null : (
            <Badge className={compact ? undefined : "ml-2"} title={fire.reason}>
              no run
            </Badge>
          )}
        </span>
      );
    }
  }
}

/** `currentThreadId`: the thread page showing this, which needs no link to itself. */
export function ThreadText({
  currentThreadId,
  scope,
  thread,
}: Readonly<{
  currentThreadId?: string | undefined;
  scope: EnvironmentScope;
  thread: ThreadBinding;
}>) {
  if (thread.kind === "new-thread-per-fire") return "New thread per fire";
  if (thread.threadId === currentThreadId) return "Continues this thread";
  return (
    <TextLink
      href={`${environmentPath(scope)}/threads/${thread.threadId}`}
      title={`Thread ${thread.threadId}`}
    >
      Continues thread
    </TextLink>
  );
}

/** `currentThreadId`: the thread page showing this, which needs no link to itself. */
export function OriginText({
  currentThreadId,
  origin,
  scope,
}: Readonly<{
  currentThreadId?: string | undefined;
  origin: AutomationOrigin;
  scope: EnvironmentScope;
}>) {
  const basePath = environmentPath(scope);
  switch (origin.kind) {
    case "agent-tool":
      return (
        <span className="inline-flex flex-wrap items-center gap-x-2">
          <span>
            Agent · <Code>{origin.toolName}</Code>
          </span>
          {origin.threadId === currentThreadId ? (
            <span>created here</span>
          ) : (
            <TextLink
              href={`${basePath}/threads/${origin.threadId}?run=${origin.runId}`}
              title={`Thread ${origin.threadId}`}
            >
              thread
            </TextLink>
          )}
          <TextLink href={`${basePath}/runs/${origin.runId}`} title={`Run ${origin.runId}`}>
            run
          </TextLink>
        </span>
      );
    case "caller":
      return (
        <span className="inline-flex flex-wrap items-center gap-x-2">
          {CALLER_LABELS[origin.actorType]}
          {origin.actorId ? <PublicId value={origin.actorId} /> : null}
        </span>
      );
    case "unrecorded":
      return "Not recorded";
  }
}

/**
 * Two lines per cell so the table fits a 1280 px window. Cadence and Source wrap; the others keep
 * their width. On a thread page, `currentThreadId` names that thread.
 */
export function AutomationTable({
  currentThreadId,
  labels,
  rows,
  scope,
}: Readonly<{
  currentThreadId?: string;
  labels: Pick<AgentLabels, "deployment">;
  rows: readonly AutomationRow[];
  scope: EnvironmentScope;
}>) {
  return (
    <Table striped>
      <TableHeader>
        <TableRow>
          <TableHead>Automation</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Cadence</TableHead>
          <TableHead>Last fire</TableHead>
          <TableHead>Source</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={`${row.kind}:${row.id}`}>
            <TableCell>
              <div className="flex max-w-48 flex-col">
                <TextLink className="truncate" href={automationPath(scope, row)} title={row.label}>
                  {row.label}
                </TextLink>
                <span
                  className={`truncate ${SECOND_LINE}`}
                  title={labels.deployment(row.agentDeploymentId)}
                >
                  {AUTOMATION_KINDS[row.kind].label} · {labels.deployment(row.agentDeploymentId)}
                </span>
              </div>
            </TableCell>
            <TableCell>
              <div className="flex flex-col items-start gap-1">
                <StatusBadge status={row.status} />
                <HealthBadge health={row.health} />
              </div>
            </TableCell>
            <TableCell className="whitespace-normal">
              <div className="flex max-w-52 flex-col">
                <span title={row.cadence.kind === "schedule" ? row.cadence.raw : undefined}>
                  {describeCadence(row.cadence)}
                </span>
                <span className={SECOND_LINE}>
                  Next <NextFireText compact nextFire={row.nextFire} />
                </span>
              </div>
            </TableCell>
            <TableCell>
              <LastFireText compact lastFire={row.lastFire} />
            </TableCell>
            <TableCell className="whitespace-normal">
              <div className="flex flex-col">
                <OriginText currentThreadId={currentThreadId} origin={row.origin} scope={scope} />
                <span className={SECOND_LINE}>
                  <ThreadText currentThreadId={currentThreadId} scope={scope} thread={row.thread} />
                </span>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
