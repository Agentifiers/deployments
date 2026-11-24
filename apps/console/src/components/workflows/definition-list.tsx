import { WorkflowSquare01Icon } from "@hugeicons/core-free-icons";
import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { definitionPagesQuery } from "../../data/workflow-queries.ts";
import type { EnvironmentScope } from "../../scope.ts";
import { NativeSelect } from "@/components/ui/native-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Code } from "@/components/ui/text";
import {
  definitionEmptyTitle,
  DEFINITION_STATUSES,
  type DefinitionFilters,
  type DefinitionStatusFilter,
} from "../../workflows/model.ts";
import { ListEmpty, LoadMore } from "../list-controls.tsx";
import { useListCreateAction } from "../list-create-action.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { ResourceLink } from "../resource-link.tsx";
import { StatusBadge } from "@/components/status-badge";

const STATUS_LABELS: Readonly<Record<DefinitionStatusFilter, string>> = {
  active: "Active",
  all: "Active and archived",
  archived: "Archived",
};

export function DefinitionStatusSelect({
  onChange,
  value,
}: Readonly<{ onChange: (next: DefinitionStatusFilter) => void; value: DefinitionStatusFilter }>) {
  return (
    <div className="w-56">
      <NativeSelect
        aria-label="Definition status"
        onChange={(event) =>
          onChange(DEFINITION_STATUSES.find((status) => status === event.target.value) ?? "active")
        }
        value={value}
      >
        {DEFINITION_STATUSES.map((status) => (
          <option key={status} value={status}>
            {STATUS_LABELS[status]}
          </option>
        ))}
      </NativeSelect>
    </div>
  );
}

export function DefinitionList({
  filters,
  scope,
}: Readonly<{ filters: DefinitionFilters; scope: EnvironmentScope }>) {
  const pagesQuery = definitionPagesQuery(scope, filters);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(pagesQuery);
  const definitions = data.pages.flatMap((page) => page.items);
  const emptyTitle = definitionEmptyTitle(filters, definitions.length, hasNextPage);
  const createAction = useListCreateAction();
  return (
    <div className="flex flex-col gap-4">
      {emptyTitle === undefined ? null : (
        <ListEmpty
          action={filters.status === "archived" ? undefined : createAction}
          docs="/docs/capabilities/workflows"
          icon={WorkflowSquare01Icon}
          title={emptyTitle}
        >
          A workflow is a JSON graph of agent, tool, approval, notification, branch, escalation, and
          end steps.
        </ListEmpty>
      )}
      {definitions.length === 0 ? null : (
        <Table striped>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Slug</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Version</TableHead>
              <TableHead>Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {definitions.map((definition) => (
              <TableRow key={definition.id}>
                <TableCell className="font-medium">
                  <ResourceLink
                    scope={scope}
                    to={{ definitionId: definition.id, kind: "workflowDefinition" }}
                  >
                    {definition.name}
                  </ResourceLink>
                </TableCell>
                <TableCell>
                  <Code>{definition.slug}</Code>
                </TableCell>
                <TableCell>
                  <StatusBadge status={definition.status} />
                </TableCell>
                <TableCell>{definition.version}</TableCell>
                <TableCell className="whitespace-nowrap">
                  <Timestamp value={definition.updatedAt} />
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
