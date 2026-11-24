import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Icon } from "../components/icon.tsx";
import { ConversationErasureStatus } from "../components/runs/conversation-erasure.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { endUserErasureQuery } from "../data/thread-queries.ts";
import type { EnvironmentScope } from "../scope.ts";

/** An end-user erasure belongs to one environment, so its status page lives under it. */
export const Route = createFileRoute(
  "/o/$orgId/p/$projectId/e/$envId/end-user-erasures/$erasureId",
)({
  loader: ({ context, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    void context.queryClient.prefetchQuery(endUserErasureQuery(scope, params.erasureId));
  },
  component: EndUserErasure,
});

function EndUserErasure() {
  const { envId, erasureId, orgId, projectId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <div className="flex flex-col gap-6">
      <Link
        className="flex items-center gap-1 text-sm/6 text-muted-foreground hover:text-foreground"
        params={{ orgId }}
        to="/o/$orgId/governance"
      >
        <Icon className="size-4" icon={ArrowLeft01Icon} />
        Data governance
      </Link>
      <SectionBoundary resetKey={erasureId}>
        <Receipt erasureId={erasureId} scope={scope} />
      </SectionBoundary>
    </div>
  );
}

function Receipt({ erasureId, scope }: Readonly<{ erasureId: string; scope: EnvironmentScope }>) {
  const { data: erasure } = useSuspenseQuery(endUserErasureQuery(scope, erasureId));
  return <ConversationErasureStatus erasure={erasure} />;
}
