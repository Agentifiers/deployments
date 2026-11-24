import { createFileRoute } from "@tanstack/react-router";
import { UsageView } from "../components/email/usage-view.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { inboxPagesQuery } from "../data/agent-email-inbox-queries.ts";
import { usageSummaryQuery } from "../data/agent-email-setup-queries.ts";
import { parseUsageSearch, type UsageSearch } from "../email/usage-state.ts";
import type { EnvironmentScope } from "../scope.ts";

// Option order matters: `loader` infers `deps` only when `validateSearch` and `loaderDeps` precede it.
export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/email/usage")({
  validateSearch: (search): UsageSearch => parseUsageSearch(search),
  loaderDeps: ({ search }) => parseUsageSearch(search),
  loader: ({ context, deps, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    void context.queryClient.prefetchQuery(
      usageSummaryQuery(scope, deps.range ?? "30d", deps.inbox),
    );
    void context.queryClient.prefetchInfiniteQuery(inboxPagesQuery(scope, undefined));
  },
  component: Usage,
});

function Usage() {
  const { envId, orgId, projectId } = Route.useParams();
  const { inbox, range = "30d" } = parseUsageSearch(Route.useSearch());
  const navigate = Route.useNavigate();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <SectionBoundary resetKey={`${range}:${inbox ?? "all"}`}>
      <UsageView
        inboxId={inbox}
        onChange={(search) => void navigate({ search })}
        range={range}
        scope={scope}
      />
    </SectionBoundary>
  );
}
