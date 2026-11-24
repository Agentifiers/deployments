import { WorkflowSquare01Icon } from "@hugeicons/core-free-icons";
import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { executionPagesQuery } from "../../data/workflow-queries.ts";
import type { EnvironmentScope } from "../../scope.ts";
import {
  EXECUTION_STATUSES,
  executionEmptyTitle,
  type ExecutionFilters,
} from "../../workflows/model.ts";
import { ListEmpty, FilterSelect, LoadMore } from "../list-controls.tsx";
import { ExecutionTable, StatusOrderNote } from "./execution-table.tsx";

export function ExecutionStatusFilter({
  filters,
  onFilter,
}: Readonly<{ filters: ExecutionFilters; onFilter: (next: ExecutionFilters) => void }>) {
  return (
    <FilterSelect
      label="Status"
      onChange={(value) => {
        const status = EXECUTION_STATUSES.find((candidate) => candidate === value);
        onFilter(status ? { status } : {});
      }}
      options={EXECUTION_STATUSES.map((status) => ({ label: status, value: status }))}
      value={filters.status}
    />
  );
}

export function ExecutionList({
  filters,
  scope,
}: Readonly<{ filters: ExecutionFilters; scope: EnvironmentScope }>) {
  const pagesQuery = executionPagesQuery(scope, filters);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(pagesQuery);
  const executions = data.pages.flatMap((page) => page.items);
  const emptyTitle = executionEmptyTitle(filters, executions.length, hasNextPage);
  return (
    <div className="flex flex-col gap-4">
      {emptyTitle === undefined ? null : (
        <ListEmpty
          docs="/docs/capabilities/workflows"
          icon={WorkflowSquare01Icon}
          title={emptyTitle}
        />
      )}
      {executions.length === 0 ? null : (
        <>
          {filters.status ? null : <StatusOrderNote />}
          <ExecutionTable executions={executions} scope={scope} />
        </>
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
