import { createFileRoute } from "@tanstack/react-router";
import { BackLink } from "../components/back-link.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { DefinitionDetail } from "../components/workflows/definition-detail.tsx";
import {
  definitionQuery,
  relatedExecutionsQuery,
  releasePagesQuery,
} from "../data/workflow-queries.ts";
import type { EnvironmentScope } from "../scope.ts";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/workflows/$definitionId")({
  loader: ({ context, params }) => {
    const scope: EnvironmentScope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    void context.queryClient.prefetchQuery(definitionQuery(scope, params.definitionId));
    void context.queryClient.prefetchInfiniteQuery(releasePagesQuery(scope, params.definitionId));
    void context.queryClient.prefetchQuery(
      relatedExecutionsQuery(scope, { definitionId: params.definitionId }),
    );
  },
  component: Definition,
});

function Definition() {
  const { definitionId, envId, orgId, projectId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <div className="flex flex-col gap-8">
      <BackLink href={`/o/${orgId}/p/${projectId}/e/${envId}/workflows`} label="Workflows" />
      <SectionBoundary resetKey={definitionId}>
        <DefinitionDetail definitionId={definitionId} scope={scope} />
      </SectionBoundary>
    </div>
  );
}
