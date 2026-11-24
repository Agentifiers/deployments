import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArtifactDetail } from "../components/artifacts/artifact-detail.tsx";
import { Icon } from "../components/icon.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { environmentQuery } from "../data/console-queries.ts";
import { agentDirectoryQuery } from "../data/observability-queries.ts";
import { artifactQuery } from "../data/thread-queries.ts";
import type { EnvironmentScope } from "../scope.ts";

export interface ArtifactSearch {
  readonly startRun?: true;
}

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/artifacts/$artifactId")({
  validateSearch: (search): ArtifactSearch =>
    search.startRun === true || search.startRun === "true" ? { startRun: true } : {},
  loader: ({ context, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    void context.queryClient.prefetchQuery(agentDirectoryQuery(scope));
    void context.queryClient.prefetchQuery(environmentQuery(scope));
    void context.queryClient.prefetchQuery(artifactQuery(scope, params.artifactId));
  },
  component: ArtifactPage,
});

function ArtifactPage() {
  const { artifactId, envId, orgId, projectId } = Route.useParams();
  const { startRun } = Route.useSearch();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <div className="flex flex-col gap-8">
      <Link
        className="flex items-center gap-1 text-sm/6 text-muted-foreground hover:text-foreground"
        params={{ envId, orgId, projectId }}
        to="/o/$orgId/p/$projectId/e/$envId/artifacts"
      >
        <Icon className="size-4" icon={ArrowLeft01Icon} />
        Artifacts
      </Link>
      <SectionBoundary resetKey={artifactId}>
        <ArtifactDetail artifactId={artifactId} offerRun={startRun === true} scope={scope} />
      </SectionBoundary>
    </div>
  );
}
