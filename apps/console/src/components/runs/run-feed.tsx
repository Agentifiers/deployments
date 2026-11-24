import {
  Cancel01Icon,
  PlayCircleIcon,
  RefreshIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import {
  useMutation,
  useQueryClient,
  useSuspenseInfiniteQuery,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState, type FormEvent } from "react";
import { automationPath } from "../../automations/automation-state.ts";
import { agentDirectoryQuery } from "../../data/observability-queries.ts";
import { runFeedPagesQuery, runtimeLookupQuery } from "../../data/runtime-queries.ts";
import { agentLabels } from "../../observability/agent-labels.ts";
import { EXECUTION_PURPOSES } from "../../observability/trace-filters.ts";
import {
  localDay,
  localDayBound,
  parseRuntimeId,
  RUN_STATUSES,
  type RunFeedFilters,
} from "../../runs/filters.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Code, Text } from "@/components/ui/text";
import { DatePicker } from "../date-picker.tsx";
import { Icon } from "../icon.tsx";
import { ListEmpty, FilterSelect, LoadMore, ReleaseFilter } from "../list-controls.tsx";
import { describeProblem } from "../section-boundary.tsx";
import { RuntimeRunTable, type AutomationLink } from "./run-table.tsx";

export type RunFeedFilterPatch = {
  readonly [Key in keyof RunFeedFilters]?: RunFeedFilters[Key] | undefined;
};

function feedOrder(filters: RunFeedFilters) {
  if (!filters.agentDeploymentId) return "Newest first.";
  return filters.status
    ? "Most recently updated first."
    : "Waiting and running runs first, then queued, failed, completed, and canceled; most recently updated first within each status.";
}

function DayFilter({
  bound,
  label,
  onChange,
  value,
}: Readonly<{
  bound: "end" | "start";
  label: string;
  onChange: (instant: string | undefined) => void;
  value: string | undefined;
}>) {
  return (
    <label className="flex items-center gap-2 text-sm/6 whitespace-nowrap text-muted-foreground">
      {label}
      <span className="w-40">
        <DatePicker
          label={label}
          onChange={(day) => onChange(localDayBound(day, bound))}
          value={value ? localDay(value) : ""}
        />
      </span>
    </label>
  );
}

export function RunFeed({
  filters,
  onFilter,
  scope,
}: Readonly<{
  filters: RunFeedFilters;
  onFilter: (patch: RunFeedFilterPatch) => void;
  scope: EnvironmentScope;
}>) {
  const queryClient = useQueryClient();
  const { data: directory } = useSuspenseQuery(agentDirectoryQuery(scope));
  const pagesQuery = runFeedPagesQuery(scope, filters);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(pagesQuery);
  const releases = useMemo(() => data.pages.flatMap((page) => page.releases), [data.pages]);
  const labels = useMemo(() => agentLabels(directory, releases), [directory, releases]);
  const runs = useMemo(() => data.pages.flatMap((page) => page.items), [data.pages]);
  const automationLinks = useMemo(
    () =>
      new Map(
        data.pages.flatMap((page) =>
          page.automations.map((entry): [string, AutomationLink] => [
            entry.id,
            { href: automationPath(scope, entry), label: entry.label },
          ]),
        ),
      ),
    [data.pages, scope],
  );
  const filteredRelease = releases.find((entry) => entry.id === filters.agentReleaseId);
  const deployments = directory.deployments
    .map((deployment) => ({ label: labels.deployment(deployment.id), value: deployment.id }))
    .toSorted((left, right) => left.label.localeCompare(right.label));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <FilterSelect
          label="Status"
          onChange={(status) =>
            onFilter({ status: RUN_STATUSES.find((candidate) => candidate === status) })
          }
          options={RUN_STATUSES.map((status) => ({ label: status, value: status }))}
          value={filters.status}
        />
        <FilterSelect
          label="Purpose"
          onChange={(purpose) =>
            onFilter({
              executionPurpose: EXECUTION_PURPOSES.find((candidate) => candidate === purpose),
            })
          }
          options={EXECUTION_PURPOSES.map((purpose) => ({ label: purpose, value: purpose }))}
          value={filters.executionPurpose}
        />
        <FilterSelect
          label="Deployment"
          onChange={(agentDeploymentId) => onFilter({ agentDeploymentId })}
          options={deployments}
          value={filters.agentDeploymentId}
        />
        <ReleaseFilter
          definitionId={filteredRelease?.definitionId}
          label="Release"
          onChange={(agentReleaseId) => onFilter({ agentReleaseId })}
          scope={scope}
          value={filters.agentReleaseId}
        />
        <DayFilter
          bound="start"
          label="Created from"
          onChange={(createdAfter) => onFilter({ createdAfter })}
          value={filters.createdAfter}
        />
        <DayFilter
          bound="end"
          label="Created through"
          onChange={(createdBefore) => onFilter({ createdBefore })}
          value={filters.createdBefore}
        />
        {filters.threadId ? (
          <Button onClick={() => onFilter({ threadId: undefined })} variant="outline">
            Thread <Code>…{filters.threadId.slice(-8)}</Code>
            <Icon icon={Cancel01Icon} />
          </Button>
        ) : null}
        <Button
          className="ml-auto"
          onClick={() => void queryClient.resetQueries({ queryKey: pagesQuery.queryKey })}
          variant="outline"
        >
          <Icon icon={RefreshIcon} />
          Refresh
        </Button>
      </div>
      <Text>{feedOrder(filters)}</Text>
      {runs.length > 0 ? (
        <RuntimeRunTable
          automationLinks={automationLinks}
          environmentPath={environmentPath(scope)}
          labels={labels}
          runs={runs}
        />
      ) : hasNextPage ? (
        <Text>No matching runs in the pages read so far. Load more to keep searching.</Text>
      ) : (
        <ListEmpty
          action={
            <Button href={`${environmentPath(scope)}/integrate`} variant="outline">
              Submit a run
            </Button>
          }
          docs="/docs/capabilities/threads-and-runs"
          icon={PlayCircleIcon}
          title="No matching runs"
        >
          Clear the filters, or submit a run to one of the environment's deployments.
        </ListEmpty>
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

export function FindRuntimeId({ scope }: Readonly<{ scope: EnvironmentScope }>) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const id = parseRuntimeId(text);
  const params = {
    envId: scope.environmentId,
    orgId: scope.organizationId,
    projectId: scope.projectId,
  };
  const lookup = useMutation({
    mutationFn: (runtimeId: string) => queryClient.fetchQuery(runtimeLookupQuery(scope, runtimeId)),
    onSuccess: (found) => {
      if (found.kind === "run") {
        void navigate({
          params: { ...params, runId: found.runId },
          to: "/o/$orgId/p/$projectId/e/$envId/runs/$runId",
        });
      }
      if (found.kind === "thread") {
        void navigate({
          params: { ...params, threadId: found.threadId },
          to: "/o/$orgId/p/$projectId/e/$envId/threads/$threadId",
        });
      }
    },
  });
  const find = (event: FormEvent) => {
    event.preventDefault();
    if (id) lookup.mutate(id);
  };
  return (
    <form className="flex flex-col gap-1" onSubmit={find}>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1 sm:w-80 sm:flex-none">
          <Input
            aria-label="Run or thread ID"
            autoComplete="off"
            aria-invalid={text.trim() !== "" && id === undefined}
            onChange={(event) => {
              setText(event.target.value);
              lookup.reset();
            }}
            placeholder="Find a run or thread by ID"
            value={text}
          />
        </div>
        <Button disabled={!id || lookup.isPending} variant="outline" type="submit">
          <Icon icon={Search01Icon} />
          {lookup.isPending ? "Finding…" : "Find"}
        </Button>
      </div>
      {lookup.data?.kind === "missing" ? (
        <Text>No run or thread in this environment has that ID.</Text>
      ) : null}
      {lookup.error ? <LookupProblem error={lookup.error} /> : null}
    </form>
  );
}

function LookupProblem({ error }: Readonly<{ error: Error }>) {
  const problem = describeProblem(error, "The lookup failed");
  return (
    <p className="text-sm/6 text-destructive">
      {problem.title}
      {problem.description ? `. ${problem.description}` : null}
    </p>
  );
}
