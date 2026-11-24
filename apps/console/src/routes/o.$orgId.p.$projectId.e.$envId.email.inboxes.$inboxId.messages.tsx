import { createFileRoute } from "@tanstack/react-router";
import { MessageList } from "../components/email/mailbox/message-views.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { messagePagesQuery } from "../data/agent-email-mailbox-queries.ts";
import { parseMessageSearch, type MessageSearch } from "../email/mailbox-state.ts";
import type { EnvironmentScope } from "../scope.ts";

// Option order matters: `loader` infers `deps` only when `validateSearch` and `loaderDeps` precede it.
export const Route = createFileRoute(
  "/o/$orgId/p/$projectId/e/$envId/email/inboxes/$inboxId/messages",
)({
  validateSearch: (search): MessageSearch => parseMessageSearch(search),
  loaderDeps: ({ search }) => parseMessageSearch(search),
  loader: ({ context, deps, params }) => {
    void context.queryClient.prefetchInfiniteQuery(
      messagePagesQuery(
        { environmentId: params.envId, organizationId: params.orgId, projectId: params.projectId },
        params.inboxId,
        deps,
      ),
    );
  },
  component: Messages,
});

function Messages() {
  const { envId, inboxId, orgId, projectId } = Route.useParams();
  const search = parseMessageSearch(Route.useSearch());
  const navigate = Route.useNavigate();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <SectionBoundary resetKey={inboxId}>
      <MessageList
        inboxId={inboxId}
        onSearch={(next) => void navigate({ search: next })}
        scope={scope}
        search={search}
      />
    </SectionBoundary>
  );
}
