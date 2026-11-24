import { createFileRoute } from "@tanstack/react-router";
import { ThreadList } from "../components/email/mailbox/thread-views.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { threadPagesQuery } from "../data/agent-email-mailbox-queries.ts";
import { parseThreadSearch, type ThreadSearch } from "../email/mailbox-state.ts";
import type { EnvironmentScope } from "../scope.ts";

// Option order matters: `loader` infers `deps` only when `validateSearch` and `loaderDeps` precede it.
export const Route = createFileRoute(
  "/o/$orgId/p/$projectId/e/$envId/email/inboxes/$inboxId/threads/",
)({
  validateSearch: (search): ThreadSearch => parseThreadSearch(search),
  loaderDeps: ({ search }) => parseThreadSearch(search),
  loader: ({ context, deps, params }) => {
    void context.queryClient.prefetchInfiniteQuery(
      threadPagesQuery(
        { environmentId: params.envId, organizationId: params.orgId, projectId: params.projectId },
        params.inboxId,
        deps,
      ),
    );
  },
  component: Threads,
});

function Threads() {
  const { envId, inboxId, orgId, projectId } = Route.useParams();
  const search = parseThreadSearch(Route.useSearch());
  const navigate = Route.useNavigate();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <SectionBoundary resetKey={inboxId}>
      <ThreadList
        inboxId={inboxId}
        onSearch={(next) => void navigate({ search: next })}
        scope={scope}
        search={search}
      />
    </SectionBoundary>
  );
}
