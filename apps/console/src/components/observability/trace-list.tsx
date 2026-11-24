import { RefreshIcon, Route01Icon } from "@hugeicons/core-free-icons";
import {
  useQuery,
  useQueryClient,
  useSuspenseInfiniteQuery,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useMemo, useState, type FormEvent } from "react";
import { organizationShellQuery } from "../../data/console-queries.ts";
import {
  agentDirectoryQuery,
  releaseFilterQuery,
  tracePagesQuery,
} from "../../data/observability-queries.ts";
import { PlatformApiError } from "../../errors.ts";
import { agentLabels, labelTrace } from "../../observability/agent-labels.ts";
import {
  EXECUTION_PURPOSES,
  OBSERVABILITY_IDENTIFIER,
  TRACE_STATUSES,
  type TraceFilters,
} from "../../observability/trace-filters.ts";
import type { EnvironmentScope } from "../../scope.ts";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Icon } from "../icon.tsx";
import { TraceExport } from "./trace-export.tsx";
import { TraceTable } from "./trace-table.tsx";

/** A filter change: a value sets the filter, `undefined` clears it. */
export type TraceFilterPatch = {
  readonly [Key in keyof TraceFilters]?: TraceFilters[Key] | undefined;
};

function FilterSelect({
  disabled = false,
  label,
  onChange,
  options,
  value,
}: Readonly<{
  disabled?: boolean;
  label: string;
  onChange: (value: string | undefined) => void;
  options: readonly { readonly label: string; readonly value: string }[];
  value: string | undefined;
}>) {
  // NativeSelect fills its container, so the wrapper sets the width.
  return (
    <div className="w-52">
      <NativeSelect
        aria-label={label}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value || undefined)}
        value={value ?? ""}
      >
        <option value="">{label}: any</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {label}: {option.label}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}

function ErrorClassFilter({
  onChange,
  value,
}: Readonly<{ onChange: (value: string | undefined) => void; value: string | undefined }>) {
  const [draft, setDraft] = useState(value ?? "");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = draft.trim();
    onChange(OBSERVABILITY_IDENTIFIER.test(trimmed) ? trimmed : undefined);
  };
  return (
    <form className="w-48" onSubmit={submit}>
      <Input
        aria-label="Error class"
        onBlur={submit}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="Error class"
        value={draft}
      />
    </form>
  );
}

/**
 * The trace list (plan §5.4) with its filters. Agent names come from the cached agent directory;
 * pages follow the hot plane's snapshot cursor, which expires after five minutes, so an expired
 * cursor restarts the list from the newest trace.
 */
export function TraceList({
  environmentPath,
  filters,
  onFilter,
  scope,
}: Readonly<{
  environmentPath: string;
  filters: TraceFilters;
  onFilter: (patch: TraceFilterPatch) => void;
  scope: EnvironmentScope;
}>) {
  const queryClient = useQueryClient();
  const pagesQuery = tracePagesQuery(scope, filters);
  const { data: directory } = useSuspenseQuery(agentDirectoryQuery(scope));
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(pagesQuery);
  const releaseOptionsQuery = useQuery({
    ...releaseFilterQuery(scope, filters.agentDefinitionId ?? ""),
    enabled: filters.agentDefinitionId !== undefined,
  });
  const filterReleases = releaseOptionsQuery.data;
  const labels = useMemo(
    () =>
      agentLabels(directory, [
        ...data.pages.flatMap((page) => page.releases),
        ...(filterReleases ?? []),
      ]),
    [data.pages, directory, filterReleases],
  );
  const traces = useMemo(
    () => data.pages.flatMap((page) => page.items.map((trace) => labelTrace(trace, labels))),
    [data.pages, labels],
  );
  const restart = () => void queryClient.resetQueries({ queryKey: pagesQuery.queryKey });
  const cursorExpired =
    error instanceof PlatformApiError && error.problem.code === "cursor_expired";

  const definitionOptions = directory.definitions.map((definition) => ({
    label: definition.name,
    value: definition.id,
  }));
  const deploymentOptions = directory.deployments
    .filter(
      (deployment) =>
        !filters.agentDefinitionId || deployment.definitionId === filters.agentDefinitionId,
    )
    .map((deployment) => ({ label: labels.deployment(deployment.id), value: deployment.id }));
  // Releases are offered for the chosen agent only; listing every agent's releases would cost a
  // request per agent.
  const releaseOptions = (filterReleases ?? []).map((release) => ({
    label: `#${release.releaseNumber}`,
    value: release.id,
  }));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <FilterSelect
          label="Status"
          onChange={(status) =>
            onFilter({ status: TRACE_STATUSES.find((candidate) => candidate === status) })
          }
          options={TRACE_STATUSES.map((status) => ({ label: status, value: status }))}
          value={filters.status}
        />
        <FilterSelect
          label="Agent"
          onChange={(agentDefinitionId) =>
            onFilter({ agentDefinitionId, agentDeploymentId: undefined, agentReleaseId: undefined })
          }
          options={definitionOptions}
          value={filters.agentDefinitionId}
        />
        <FilterSelect
          label="Deployment"
          onChange={(agentDeploymentId) => onFilter({ agentDeploymentId })}
          options={deploymentOptions}
          value={filters.agentDeploymentId}
        />
        <FilterSelect
          disabled={filters.agentDefinitionId === undefined}
          label="Release"
          onChange={(agentReleaseId) => onFilter({ agentReleaseId })}
          options={releaseOptions}
          value={filters.agentReleaseId}
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
        <ErrorClassFilter
          key={filters.errorClass ?? ""}
          onChange={(errorClass) => onFilter({ errorClass })}
          value={filters.errorClass}
        />
        <div className="ml-auto flex gap-2">
          {shell.access.createObservabilityExport ? (
            <TraceExport directory={directory} filters={filters} scope={scope} />
          ) : null}
          <Button onClick={restart} variant="outline">
            <Icon icon={RefreshIcon} />
            Refresh
          </Button>
        </div>
      </div>

      {traces.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Icon icon={Route01Icon} />
            </EmptyMedia>
            <EmptyTitle>No matching traces</EmptyTitle>
            <EmptyDescription>Widen the range or clear filters.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <TraceTable environmentPath={environmentPath} traces={traces} />
      )}

      {cursorExpired ? (
        <p className="text-sm/6 text-muted-foreground">
          This list is more than five minutes old.{" "}
          <button className="font-medium text-foreground underline" onClick={restart} type="button">
            Reload from the newest trace
          </button>
          .
        </p>
      ) : error ? (
        <p className="text-sm/6 text-destructive">{error.message}</p>
      ) : null}
      {hasNextPage && !cursorExpired ? (
        <div>
          <Button
            disabled={isFetchingNextPage}
            onClick={() => void fetchNextPage()}
            variant="outline"
          >
            {isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
