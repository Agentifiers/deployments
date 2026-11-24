import { PlayCircleIcon, RefreshIcon } from "@hugeicons/core-free-icons";
import { useQueryClient, useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { agentRunPagesQuery } from "../../../data/agent-runtime-queries.ts";
import { agentLabels } from "../../../observability/agent-labels.ts";
import { EXECUTION_PURPOSES } from "../../../observability/trace-filters.ts";
import { RUN_STATUSES, type RunFilters } from "../../../runs/filters.ts";
import type { EnvironmentScope } from "../../../scope.ts";
import type { AgentDetail } from "../../../server/agent-data.ts";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Text } from "@/components/ui/text";
import { DocsLink } from "../../docs-link.tsx";
import { Icon } from "../../icon.tsx";
import { FilterSelect, LoadMore } from "../../list-controls.tsx";
import { RuntimeRunTable } from "../../runs/run-table.tsx";

/** A filter change: a value sets the filter, `undefined` clears it. */
export type RunFilterPatch = { readonly [Key in keyof RunFilters]?: RunFilters[Key] | undefined };

export function AgentRuns({
  agent,
  environmentPath,
  filters,
  onFilter,
  scope,
}: Readonly<{
  agent: AgentDetail;
  environmentPath: string;
  filters: RunFilters;
  onFilter: (patch: RunFilterPatch) => void;
  scope: EnvironmentScope;
}>) {
  const queryClient = useQueryClient();
  const deploymentIds = agent.deployments.map((deployment) => deployment.id);
  const pagesQuery = agentRunPagesQuery(scope, agent.definition.id, deploymentIds, filters);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(pagesQuery);
  const runs = useMemo(() => data.pages.flatMap((page) => page.runs), [data.pages]);
  const labels = useMemo(() => {
    const definitionId = agent.definition.id;
    return agentLabels(
      {
        definitions: [agent.definition],
        deployments: agent.deployments.map(({ id }) => ({ definitionId, id })),
      },
      agent.releases.map(({ id, releaseNumber }) => ({ definitionId, id, releaseNumber })),
    );
  }, [agent]);
  const restart = () => void queryClient.resetQueries({ queryKey: pagesQuery.queryKey });

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
        <Button className="ml-auto" onClick={restart} variant="outline">
          <Icon icon={RefreshIcon} />
          Refresh
        </Button>
      </div>
      <Text>
        {filters.status
          ? "Most recently updated first."
          : "Waiting and running runs first, then queued, failed, completed, and canceled; most recently updated first within each status. Filter by status for one timeline."}{" "}
        Playground previews and evaluation runs are not listed here; find them on the Playground and
        Evaluations tabs.
      </Text>

      {runs.length > 0 ? (
        <RuntimeRunTable environmentPath={environmentPath} labels={labels} runs={runs} />
      ) : hasNextPage ? (
        <Text>No matching runs in the pages read so far. Load more to keep searching.</Text>
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Icon icon={PlayCircleIcon} />
            </EmptyMedia>
            <EmptyTitle>
              {agent.deployments.length === 0 ? "No deployments" : "No matching runs"}
            </EmptyTitle>
            <EmptyDescription>
              {agent.deployments.length === 0
                ? "Runs appear once the agent is deployed."
                : "Clear the filters, or send the agent work through the API."}{" "}
              <DocsLink path="/docs/capabilities/threads-and-runs" />
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
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
