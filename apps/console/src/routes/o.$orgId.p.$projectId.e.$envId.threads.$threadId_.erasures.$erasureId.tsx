import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Icon } from "../components/icon.tsx";
import { ConversationErasureStatus } from "../components/runs/conversation-erasure.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { threadErasureQuery } from "../data/thread-queries.ts";
import type { EnvironmentScope } from "../scope.ts";

export const Route = createFileRoute(
  "/o/$orgId/p/$projectId/e/$envId/threads/$threadId_/erasures/$erasureId",
)({
  loader: ({ context, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    void context.queryClient.prefetchQuery(
      threadErasureQuery(scope, params.threadId, params.erasureId),
    );
  },
  component: ThreadErasure,
});

function ThreadErasure() {
  const { envId, erasureId, orgId, projectId, threadId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <div className="flex flex-col gap-6">
      <Link
        className="flex items-center gap-1 text-sm/6 text-muted-foreground hover:text-foreground"
        params={{ envId, orgId, projectId }}
        to="/o/$orgId/p/$projectId/e/$envId/threads"
      >
        <Icon className="size-4" icon={ArrowLeft01Icon} />
        Threads
      </Link>
      <SectionBoundary resetKey={erasureId}>
        <Receipt erasureId={erasureId} scope={scope} threadId={threadId} />
      </SectionBoundary>
    </div>
  );
}

function Receipt({
  erasureId,
  scope,
  threadId,
}: Readonly<{ erasureId: string; scope: EnvironmentScope; threadId: string }>) {
  const { data: erasure } = useSuspenseQuery(threadErasureQuery(scope, threadId, erasureId));
  return <ConversationErasureStatus erasure={erasure} />;
}
