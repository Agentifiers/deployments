import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Icon } from "../components/icon.tsx";
import { ThreadTranscript } from "../components/runs/thread-transcript.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import { agentDirectoryQuery } from "../data/observability-queries.ts";
import { threadQuery, threadRunPagesQuery } from "../data/runtime-queries.ts";
import { artifactPagesQuery } from "../data/thread-queries.ts";
import { parseThreadSearch, type ThreadSearch } from "../runs/filters.ts";
import type { EnvironmentScope } from "../scope.ts";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/threads/$threadId")({
  validateSearch: (search): ThreadSearch => parseThreadSearch(search),
  loader: async ({ context, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    const { queryClient } = context;
    void queryClient.prefetchQuery(agentDirectoryQuery(scope));
    void queryClient.prefetchQuery(threadQuery(scope, params.threadId));
    const { access } = await queryClient.ensureQueryData(organizationShellQuery(params.orgId));
    if (access.listRuns) {
      void queryClient.prefetchInfiniteQuery(threadRunPagesQuery(scope, params.threadId));
    }
    if (access.listArtifacts) {
      void queryClient.prefetchInfiniteQuery(
        artifactPagesQuery(scope, { kind: "thread", threadId: params.threadId }),
      );
    }
  },
  component: ThreadPage,
});

function ThreadPage() {
  const { envId, orgId, projectId, threadId } = Route.useParams();
  const { run } = Route.useSearch();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <div className="flex flex-col gap-8">
      <Link
        className="flex items-center gap-1 text-sm/6 text-muted-foreground hover:text-foreground"
        params={{ envId, orgId, projectId }}
        to="/o/$orgId/p/$projectId/e/$envId/threads"
      >
        <Icon className="size-4" icon={ArrowLeft01Icon} />
        Threads
      </Link>
      <SectionBoundary resetKey={threadId}>
        <ThreadTranscript focusRunId={run} scope={scope} threadId={threadId} />
      </SectionBoundary>
    </div>
  );
}
