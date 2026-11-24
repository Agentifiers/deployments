import {
  useInfiniteQuery,
  useQueryClient,
  useSuspenseInfiniteQuery,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import { loadedRows } from "../../automations/automation-listing.ts";
import { automationViewPagesQuery, invalidateAutomations } from "../../data/automation-queries.ts";
import { organizationShellQuery } from "../../data/console-queries.ts";
import { agentDirectoryQuery } from "../../data/observability-queries.ts";
import { threadRunPagesQuery } from "../../data/runtime-queries.ts";
import { agentLabels } from "../../observability/agent-labels.ts";
import { isRunInFlight } from "../../runs/run-state.ts";
import type { EnvironmentScope } from "../../scope.ts";
import { Subheading } from "@/components/ui/heading";
import { LoadMore } from "../list-controls.tsx";
import { SectionBoundary } from "../section-boundary.tsx";
import { AutomationTable } from "./automation-table.tsx";

/**
 * Automations tied to a thread: those whose fires continue it and those an agent created in it,
 * in every status. Renders nothing while it loads, when there are none, or when the caller cannot
 * read automations; errors render inline.
 */
export function ThreadAutomations({
  scope,
  threadId,
}: Readonly<{ scope: EnvironmentScope; threadId: string }>) {
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  if (!shell.access.listSchedules) return null;
  return (
    <SectionBoundary fallback={null} resetKey={threadId}>
      <ThreadAutomationSection
        canListRuns={shell.access.listRuns}
        scope={scope}
        threadId={threadId}
      />
    </SectionBoundary>
  );
}

function ThreadAutomationSection({
  canListRuns,
  scope,
  threadId,
}: Readonly<{ canListRuns: boolean; scope: EnvironmentScope; threadId: string }>) {
  const queryClient = useQueryClient();
  const { data: directory } = useSuspenseQuery(agentDirectoryQuery(scope));
  const pagesQuery = automationViewPagesQuery(scope, { kind: "thread", threadId });
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(pagesQuery);
  const { data: runInFlight } = useInfiniteQuery({
    ...threadRunPagesQuery(scope, threadId),
    enabled: canListRuns,
    select: (runs) =>
      runs.pages.some((page) => page.items.some((run) => isRunInFlight(run.status))),
  });
  const hadRunInFlight = useRef(runInFlight);
  useEffect(() => {
    const settled = hadRunInFlight.current === true && runInFlight === false;
    hadRunInFlight.current = runInFlight;
    // An agent run in the thread is what creates a reminder there, so a finished run re-reads the
    // listing, which the section otherwise refreshes only around its next fire.
    if (settled) void invalidateAutomations(queryClient, scope);
  }, [queryClient, runInFlight, scope]);
  const labels = useMemo(() => agentLabels(directory), [directory]);
  const rows = loadedRows(data.pages);
  if (rows.length === 0) return null;
  return (
    <section className="flex flex-col gap-4">
      <Subheading>Automations</Subheading>
      <AutomationTable currentThreadId={threadId} labels={labels} rows={rows} scope={scope} />
      <LoadMore
        error={error}
        fetchNextPage={fetchNextPage}
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        queryKey={pagesQuery.queryKey}
      />
    </section>
  );
}
