import { createFileRoute } from "@tanstack/react-router";
import { BackLink } from "../components/back-link.tsx";
import { ScorerDetail } from "../components/evaluations/scorers.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import { scorerQuery } from "../data/evaluation-queries.ts";
import { scoreResultPagesQuery } from "../data/score-result-queries.ts";
import type { EnvironmentScope } from "../scope.ts";

export const Route = createFileRoute(
  "/o/$orgId/p/$projectId/e/$envId/evaluations/scorers/$scoreDefinitionId",
)({
  loader: async ({ context, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    const { queryClient } = context;
    void queryClient.prefetchQuery(scorerQuery(scope, params.scoreDefinitionId));
    const { access } = await queryClient.ensureQueryData(organizationShellQuery(params.orgId));
    if (access.listScoreResults) {
      void queryClient.prefetchInfiniteQuery(
        scoreResultPagesQuery(scope, params.scoreDefinitionId),
      );
    }
  },
  component: Scorer,
});

function Scorer() {
  const { envId, orgId, projectId, scoreDefinitionId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <div className="flex flex-col gap-8">
      <BackLink
        href={`/o/${orgId}/p/${projectId}/e/${envId}/evaluations/scorers`}
        label="Scorers"
      />
      <SectionBoundary resetKey={scoreDefinitionId}>
        <ScorerDetail scope={scope} scoreDefinitionId={scoreDefinitionId} />
      </SectionBoundary>
    </div>
  );
}
