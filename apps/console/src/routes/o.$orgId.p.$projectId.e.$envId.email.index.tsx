import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { EmailSetup } from "../components/email/inbox-list.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { inboxPagesQuery } from "../data/agent-email-inbox-queries.ts";
import { emailSetupQuery } from "../data/agent-email-setup-queries.ts";
import { organizationShellQuery } from "../data/console-queries.ts";
import { parseInboxSearch, type InboxSearch } from "../email/inbox-state.ts";
import type { EnvironmentScope } from "../scope.ts";

// Option order matters: `loader` infers `deps` only when `validateSearch` and `loaderDeps` precede it.
export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/email/")({
  validateSearch: (search): InboxSearch => parseInboxSearch(search),
  loaderDeps: ({ search }) => parseInboxSearch(search),
  loader: ({ context, deps, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    void context.queryClient.prefetchQuery(emailSetupQuery(scope));
    void context.queryClient.prefetchInfiniteQuery(inboxPagesQuery(scope, deps.status));
  },
  component: Inboxes,
});

function Inboxes() {
  const { envId, orgId, projectId } = Route.useParams();
  const { status } = parseInboxSearch(Route.useSearch());
  const navigate = Route.useNavigate();
  const { data: shell } = useSuspenseQuery(organizationShellQuery(orgId));
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  if (!shell.access.listAgentEmailInboxes && shell.access.listEmailTenants) {
    return (
      <Navigate
        params={{ envId, orgId, projectId }}
        replace
        to="/o/$orgId/p/$projectId/e/$envId/email/tenants"
      />
    );
  }
  return (
    <SectionBoundary resetKey={envId}>
      <EmailSetup
        onStatus={(next) => void navigate({ search: next === undefined ? {} : { status: next } })}
        scope={scope}
        status={status}
      />
    </SectionBoundary>
  );
}
