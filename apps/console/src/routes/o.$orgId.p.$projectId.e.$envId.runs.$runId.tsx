import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Icon } from "../components/icon.tsx";
import { RunDetail } from "../components/runs/run-detail.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import { agentDirectoryQuery, runTraceQuery } from "../data/observability-queries.ts";
import { runDetailQuery } from "../data/runtime-queries.ts";
import { artifactPagesQuery } from "../data/thread-queries.ts";
import type { EnvironmentScope } from "../scope.ts";
import { Heading } from "@/components/ui/heading";
import { Code } from "@/components/ui/text";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/runs/$runId")({
  loader: async ({ context, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    const { queryClient } = context;
    void queryClient.prefetchQuery(agentDirectoryQuery(scope));
    void queryClient.prefetchQuery(runDetailQuery(scope, params.runId));
    const { access } = await queryClient.ensureQueryData(organizationShellQuery(params.orgId));
    if (access.getObservabilityRunTrace) {
      void queryClient.prefetchQuery(runTraceQuery(scope, params.runId));
    }
    if (access.listArtifacts) {
      void queryClient.prefetchInfiniteQuery(
        artifactPagesQuery(scope, { kind: "run", runId: params.runId }),
      );
    }
  },
  component: Run,
});

function Run() {
  const { envId, orgId, projectId, runId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        <Link
          className="flex items-center gap-1 text-sm/6 text-muted-foreground hover:text-foreground"
          params={{ envId, orgId, projectId }}
          to="/o/$orgId/p/$projectId/e/$envId/runs"
        >
          <Icon className="size-4" icon={ArrowLeft01Icon} />
          Runs
        </Link>
        <Heading>
          Run <Code>{runId}</Code>
        </Heading>
      </div>
      <SectionBoundary resetKey={runId}>
        <RunDetail runId={runId} scope={scope} />
      </SectionBoundary>
    </div>
  );
}
