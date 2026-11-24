import { BubbleChatIcon, RefreshIcon } from "@hugeicons/core-free-icons";
import { useQueryClient, useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { organizationShellQuery } from "../../data/console-queries.ts";
import { agentDirectoryQuery } from "../../data/observability-queries.ts";
import { threadPagesQuery } from "../../data/thread-queries.ts";
import { agentLabels } from "../../observability/agent-labels.ts";
import { THREAD_STATES, type ThreadFilters } from "../../runs/thread-filters.ts";
import { actorLabel, channelLabel } from "../../runs/thread-labels.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHead,
  TableRow,
} from "@/components/ui/table";
import { Text } from "@/components/ui/text";
import { Icon } from "../icon.tsx";
import { FilterSelect, LoadMore } from "../list-controls.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";

export type ThreadFilterPatch = {
  readonly [Key in keyof ThreadFilters]?: ThreadFilters[Key] | undefined;
};

/** The environment's customer threads, most recently active first. */
export function ThreadList({
  filters,
  onFilter,
  scope,
}: Readonly<{
  filters: ThreadFilters;
  onFilter: (patch: ThreadFilterPatch) => void;
  scope: EnvironmentScope;
}>) {
  const queryClient = useQueryClient();
  const { data: directory } = useSuspenseQuery(agentDirectoryQuery(scope));
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const pagesQuery = threadPagesQuery(scope, filters);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(pagesQuery);
  const threads = useMemo(() => data.pages.flatMap((page) => page.items), [data.pages]);
  const labels = useMemo(() => agentLabels(directory), [directory]);
  const deployments = directory.deployments
    .map((deployment) => ({ label: labels.deployment(deployment.id), value: deployment.id }))
    .toSorted((left, right) => left.label.localeCompare(right.label));
  const basePath = environmentPath(scope);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <FilterSelect
          label="Deployment"
          onChange={(agentDeploymentId) => onFilter({ agentDeploymentId })}
          options={deployments}
          value={filters.agentDeploymentId}
        />
        <FilterSelect
          label="State"
          onChange={(state) => onFilter({ state: THREAD_STATES.find((value) => value === state) })}
          options={THREAD_STATES.map((state) => ({ label: state, value: state }))}
          value={filters.state}
        />
        <Button
          className="ml-auto"
          onClick={() => void queryClient.resetQueries({ queryKey: pagesQuery.queryKey })}
          variant="outline"
        >
          <Icon icon={RefreshIcon} />
          Refresh
        </Button>
      </div>
      <Text>
        Most recently active first. Preview and evaluation threads stay with their preview or
        evaluation run.
      </Text>
      {threads.length > 0 ? (
        <Table striped>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Deployment</TableHead>
              <TableHead>Channel</TableHead>
              <TableHead>Started by</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Last activity</TableHead>
              <TableHead>ID</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {threads.map((thread) => (
              <TableRow
                href={`${basePath}/threads/${thread.id}`}
                key={thread.id}
                title={thread.title || "Untitled thread"}
              >
                <TableCell className="max-w-72 truncate">
                  {thread.title || <span className="text-muted-foreground">Untitled thread</span>}
                  {thread.archived ? (
                    <Badge className="ml-2" color="zinc">
                      archived
                    </Badge>
                  ) : null}
                </TableCell>
                <TableCell className="max-w-48 truncate">
                  {thread.agentDeploymentId ? labels.deployment(thread.agentDeploymentId) : "—"}
                </TableCell>
                <TableCell>{channelLabel(thread.channel)}</TableCell>
                <TableCell>{actorLabel(thread.createdBy, shell.principalId)}</TableCell>
                <TableCell className="whitespace-nowrap">
                  <Timestamp value={thread.createdAt} />
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <Timestamp value={thread.updatedAt} />
                </TableCell>
                <TableCell>
                  <PublicId value={thread.id} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : hasNextPage ? (
        <Text>No matching threads in the pages read so far. Load more to keep searching.</Text>
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Icon icon={BubbleChatIcon} />
            </EmptyMedia>
            <EmptyTitle>No matching threads</EmptyTitle>
            <EmptyDescription>
              Clear the filters, or start a conversation with one of the environment&apos;s
              deployments from its Chat tab or through the API.
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
