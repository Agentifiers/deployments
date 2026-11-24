import { TimeScheduleIcon } from "@hugeicons/core-free-icons";
import { useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useMemo, type ReactNode } from "react";
import { loadedRows } from "../../automations/automation-listing.ts";
import {
  AUTOMATION_KINDS,
  type AutomationFilters,
  type AutomationKind,
} from "../../automations/automation-state.ts";
import { automationViewPagesQuery } from "../../data/automation-queries.ts";
import { agentDirectoryQuery } from "../../data/observability-queries.ts";
import { agentLabels, type AgentLabels } from "../../observability/agent-labels.ts";
import { formatExact } from "../../observability/format.ts";
import type { EnvironmentScope } from "../../scope.ts";
import { Code, Text } from "@/components/ui/text";
import { SingleToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { ListEmpty, FilterSelect, LoadMore } from "../list-controls.tsx";
import { SectionBoundary } from "../section-boundary.tsx";
import { AutomationTable } from "./automation-table.tsx";

/** Raw filter values; the route parses the merged search with `parseAutomationFilters`. */
export type AutomationFilterPatch = {
  readonly [Key in keyof AutomationFilters]?: string | undefined;
};

const KIND_ORDER: readonly AutomationKind[] = ["schedule", "heartbeat"];

const ORIGIN_OPTIONS = [
  { label: "Agent", value: "agent" },
  { label: "API", value: "caller" },
] as const satisfies readonly { label: string; value: NonNullable<AutomationFilters["origin"]> }[];

/**
 * The environment's automations, or an agent's when `deploymentIds` lists its deployments. Filters
 * live in the URL; archived and disabled automations stay hidden unless `show` is `all`.
 */
export function AutomationList({
  deploymentIds,
  emptyAction,
  filters,
  onFilter,
  scope,
}: Readonly<{
  deploymentIds?: readonly string[];
  emptyAction?: ReactNode;
  filters: AutomationFilters;
  onFilter: (patch: AutomationFilterPatch) => void;
  scope: EnvironmentScope;
}>) {
  const { data: directory } = useSuspenseQuery(agentDirectoryQuery(scope));
  const labels = useMemo(() => agentLabels(directory), [directory]);
  const deployments = directory.deployments
    .filter((deployment) => deploymentIds?.includes(deployment.id) ?? true)
    .map((deployment) => ({ label: labels.deployment(deployment.id), value: deployment.id }))
    .toSorted((left, right) => left.label.localeCompare(right.label));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <FilterSelect
          label="Kind"
          onChange={(kind) => onFilter({ kind })}
          options={KIND_ORDER.map((kind) => ({ label: AUTOMATION_KINDS[kind].label, value: kind }))}
          value={filters.kind}
        />
        <FilterSelect
          label="Origin"
          onChange={(origin) => onFilter({ origin })}
          options={ORIGIN_OPTIONS}
          value={filters.origin}
        />
        {deployments.length > 1 || filters.agentDeploymentId ? (
          <FilterSelect
            label="Deployment"
            onChange={(agentDeploymentId) => onFilter({ agentDeploymentId })}
            options={deployments}
            value={filters.agentDeploymentId}
          />
        ) : null}
        <SingleToggleGroup
          aria-label="Automations shown"
          onValueChange={(show) => {
            if (show) onFilter({ show: show === "all" ? show : undefined });
          }}
          size="sm"
          value={filters.show ?? "current"}
        >
          <ToggleGroupItem value="current">Current</ToggleGroupItem>
          <ToggleGroupItem value="all">All</ToggleGroupItem>
        </SingleToggleGroup>
      </div>
      <SectionBoundary resetKey={JSON.stringify(filters)}>
        <AutomationResults
          deploymentIds={deploymentIds}
          emptyAction={emptyAction}
          filters={filters}
          labels={labels}
          scope={scope}
        />
      </SectionBoundary>
    </div>
  );
}

function AutomationResults({
  deploymentIds,
  emptyAction,
  filters,
  labels,
  scope,
}: Readonly<{
  deploymentIds: readonly string[] | undefined;
  emptyAction: ReactNode;
  filters: AutomationFilters;
  labels: AgentLabels;
  scope: EnvironmentScope;
}>) {
  const pagesQuery = automationViewPagesQuery(scope, {
    filters,
    kind: "list",
    ...(deploymentIds ? { deploymentIds } : {}),
  });
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(pagesQuery);
  const rows = loadedRows(data.pages);
  const hidden = data.pages[0]?.hidden ?? 0;
  const filtered = Boolean(filters.kind || filters.origin || filters.agentDeploymentId);
  return (
    <div className="flex flex-col gap-4">
      {rows.length === 0 ? (
        <ListEmpty
          action={filtered ? undefined : emptyAction}
          docs="/docs/capabilities/automations"
          icon={TimeScheduleIcon}
          title={
            filtered
              ? "No matching automations"
              : hidden > 0
                ? "No current automations"
                : "No automations"
          }
        >
          Schedules run an agent on a calendar and heartbeats on an interval. Create them on the
          environment&apos;s Automations page. Agents also create schedules themselves with the{" "}
          <Code>agent.schedule.remind</Code> and <Code>agent.schedule.create</Code> tools.
        </ListEmpty>
      ) : (
        <AutomationTable labels={labels} rows={rows} scope={scope} />
      )}
      <LoadMore
        error={error}
        fetchNextPage={fetchNextPage}
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        queryKey={pagesQuery.queryKey}
      />
      {filters.show === "all" ? null : (
        <Text>
          {hidden > 0
            ? `${formatExact(hidden)} archived or disabled ${hidden === 1 ? "automation is" : "automations are"} hidden.`
            : "Archived and disabled automations are hidden."}
        </Text>
      )}
    </div>
  );
}
