import { useQueryClient, useSuspenseInfiniteQuery } from "@tanstack/react-query";
import {
  AUTOMATION_KINDS,
  type AutomationRow,
  type FireRow,
} from "../../automations/automation-state.ts";
import { firePagesQuery } from "../../data/automation-queries.ts";
import { IN_FLIGHT_REFRESH_MS } from "../../data/refresh.ts";
import { PlatformApiError } from "../../errors.ts";
import type { RunStatus } from "../../runs/run-state.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import type { FireView } from "../../server/automation-data.ts";
import { type BadgeColor } from "../../status.ts";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHead,
  TableRow,
} from "@/components/ui/table";
import { Code, Text, TextLink } from "@/components/ui/text";
import { LoadMore } from "../list-controls.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { StatusBadge } from "@/components/status-badge";

const OUTCOME_COLORS: Readonly<Record<FireRow["outcome"], BadgeColor>> = {
  "not-started": "amber",
  skipped: "zinc",
  started: "green",
};

const OUTCOME_LABELS: Readonly<Record<FireRow["outcome"], string>> = {
  "not-started": "no run",
  skipped: "skipped",
  started: "started",
};

/** Runs that settle within seconds; waiting runs can sit for hours and are not polled. */
const POLLED_RUN_STATUSES: readonly RunStatus[] = ["queued", "running"];

function RunCell({ basePath, view }: Readonly<{ basePath: string; view: FireView }>) {
  const { fire, run } = view;
  if (fire.runId === undefined) return "—";
  if (run?.kind !== "loaded") {
    return (
      <span className="inline-flex items-center gap-2">
        <Code title={`Run ${fire.runId}`}>…{fire.runId.slice(-8)}</Code>
        <Badge>run unavailable</Badge>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2">
      <TextLink href={`${basePath}/runs/${fire.runId}`} title={`Run ${fire.runId}`}>
        <Code>…{fire.runId.slice(-8)}</Code>
      </TextLink>
      <StatusBadge status={run.status} />
    </span>
  );
}

/**
 * The automation's fires, newest first. It polls while a listed run is queued or running, or
 * while the automation provisions, so a fire's run status settles without a reload.
 */
export function FireTable({
  automation,
  scope,
}: Readonly<{ automation: AutomationRow; scope: EnvironmentScope }>) {
  const queryClient = useQueryClient();
  const pagesQuery = firePagesQuery(scope, automation);
  const provisioning = automation.status === "provisioning";
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } = useSuspenseInfiniteQuery({
    ...pagesQuery,
    refetchInterval: (query) =>
      provisioning ||
      query.state.data?.pages.some((page) =>
        page.items.some(
          ({ run }) => run?.kind === "loaded" && POLLED_RUN_STATUSES.includes(run.status),
        ),
      )
        ? IN_FLIGHT_REFRESH_MS
        : false,
  });
  const views = data.pages.flatMap((page) => page.items);
  const basePath = environmentPath(scope);

  if (views.length === 0) {
    return (
      <Text>
        No fires yet. Each time the {AUTOMATION_KINDS[automation.kind].label.toLowerCase()} fires,
        the run it started appears here.
      </Text>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <Table striped>
        <TableHeader>
          <TableRow>
            <TableHead>Fired at</TableHead>
            <TableHead>Scheduled for</TableHead>
            <TableHead>Source</TableHead>
            <TableHead>Outcome</TableHead>
            <TableHead>Reason</TableHead>
            <TableHead>Run</TableHead>
            <TableHead>Thread</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {views.map((view) => {
            const { fire } = view;
            return (
              <TableRow key={fire.id}>
                <TableCell className="whitespace-nowrap">
                  <Timestamp value={fire.at} />
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {fire.scheduledFor ? <Timestamp value={fire.scheduledFor} /> : "—"}
                </TableCell>
                <TableCell>{fire.source}</TableCell>
                <TableCell>
                  <Badge color={OUTCOME_COLORS[fire.outcome]}>{OUTCOME_LABELS[fire.outcome]}</Badge>
                </TableCell>
                <TableCell className="max-w-96 truncate" title={fire.reason}>
                  {fire.reason ?? "—"}
                </TableCell>
                <TableCell>
                  <RunCell basePath={basePath} view={view} />
                </TableCell>
                <TableCell>
                  {fire.threadId ? (
                    <TextLink
                      href={`${basePath}/threads/${fire.threadId}${fire.runId ? `?run=${fire.runId}` : ""}`}
                      title={`Thread ${fire.threadId}`}
                    >
                      <Code>…{fire.threadId.slice(-8)}</Code>
                    </TextLink>
                  ) : (
                    "—"
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {error instanceof PlatformApiError && error.problem.code === "invalid_cursor" ? (
        <p className="text-sm/6 text-muted-foreground">
          This list's cursor is no longer valid.{" "}
          <button
            className="font-medium text-foreground underline"
            onClick={() => void queryClient.resetQueries({ queryKey: pagesQuery.queryKey })}
            type="button"
          >
            Reload from the start
          </button>
          .
        </p>
      ) : (
        <LoadMore
          error={error}
          fetchNextPage={fetchNextPage}
          hasNextPage={hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          queryKey={pagesQuery.queryKey}
        />
      )}
    </div>
  );
}
