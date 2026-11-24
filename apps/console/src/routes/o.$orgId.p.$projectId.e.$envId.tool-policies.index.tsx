import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { PolicyList } from "../components/tool-policies/policy-list.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import { policyPagesQuery } from "../data/tool-policy-queries.ts";
import type { EnvironmentScope } from "../scope.ts";
import { parsePolicySearch, type PolicySearch } from "../tool-policies/policy-state.ts";

// Option order matters: `loader` infers `deps` only when `validateSearch` and `loaderDeps` precede it.
export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/tool-policies/")({
  validateSearch: (search): PolicySearch => parsePolicySearch(search),
  loaderDeps: ({ search }) => parsePolicySearch(search),
  loader: async ({ context, deps, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    const { access } = await context.queryClient.ensureQueryData(
      organizationShellQuery(params.orgId),
    );
    if (access.listToolPolicies) {
      void context.queryClient.prefetchInfiniteQuery(
        policyPagesQuery(scope, deps.show ?? "active"),
      );
    }
  },
  component: Policies,
});

function Policies() {
  const { envId, orgId, projectId } = Route.useParams();
  const view = parsePolicySearch(Route.useSearch()).show ?? "active";
  const navigate = Route.useNavigate();
  const { access } = useSuspenseQuery(organizationShellQuery(orgId)).data;
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  if (!access.listToolPolicies && access.listTools) {
    return (
      <Navigate
        params={{ envId, orgId, projectId }}
        replace
        to="/o/$orgId/p/$projectId/e/$envId/tool-policies/catalog"
      />
    );
  }
  return (
    <SectionBoundary resetKey={envId}>
      <PolicyList
        onView={(next) => void navigate({ search: next === "all" ? { show: next } : {} })}
        scope={scope}
        view={view}
      />
    </SectionBoundary>
  );
}
