import { createFileRoute } from "@tanstack/react-router";
import { DraftList } from "../components/email/mailbox/draft-views.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { draftPagesQuery } from "../data/agent-email-mailbox-queries.ts";
import { parseDraftSearch, type DraftSearch } from "../email/mailbox-state.ts";
import type { EnvironmentScope } from "../scope.ts";

// Option order matters: `loader` infers `deps` only when `validateSearch` and `loaderDeps` precede it.
export const Route = createFileRoute(
  "/o/$orgId/p/$projectId/e/$envId/email/inboxes/$inboxId/drafts",
)({
  validateSearch: (search): DraftSearch => parseDraftSearch(search),
  loaderDeps: ({ search }) => parseDraftSearch(search),
  loader: ({ context, deps, params }) => {
    void context.queryClient.prefetchInfiniteQuery(
      draftPagesQuery(
        { environmentId: params.envId, organizationId: params.orgId, projectId: params.projectId },
        params.inboxId,
        deps,
      ),
    );
  },
  component: Drafts,
});

function Drafts() {
  const { envId, inboxId, orgId, projectId } = Route.useParams();
  const search = parseDraftSearch(Route.useSearch());
  const navigate = Route.useNavigate();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <SectionBoundary resetKey={inboxId}>
      <DraftList
        inboxId={inboxId}
        onSearch={(next) => void navigate({ search: next })}
        scope={scope}
        search={search}
      />
    </SectionBoundary>
  );
}
