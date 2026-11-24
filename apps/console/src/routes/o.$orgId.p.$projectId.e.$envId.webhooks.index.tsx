import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { WebhookList } from "../components/webhooks/webhook-list.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import { endpointPagesQuery } from "../data/webhook-queries.ts";
import type { EnvironmentScope } from "../scope.ts";
import { parseEndpointSearch, type EndpointSearch } from "../webhooks/webhook-state.ts";

// Option order matters: `loader` infers `deps` only when `validateSearch` and `loaderDeps` precede it.
export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/webhooks/")({
  validateSearch: (search): EndpointSearch => parseEndpointSearch(search),
  loaderDeps: ({ search }) => parseEndpointSearch(search),
  loader: ({ context, deps, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    void context.queryClient.prefetchInfiniteQuery(
      endpointPagesQuery(scope, deps.show ?? "active"),
    );
  },
  component: Endpoints,
});

function Endpoints() {
  const { envId, orgId, projectId } = Route.useParams();
  const view = parseEndpointSearch(Route.useSearch()).show ?? "active";
  const navigate = Route.useNavigate();
  const { data: shell } = useSuspenseQuery(organizationShellQuery(orgId));
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  if (!shell.access.listWebhooks && shell.access.listWebhookDeliveries) {
    return (
      <Navigate
        params={{ envId, orgId, projectId }}
        replace
        to="/o/$orgId/p/$projectId/e/$envId/webhooks/deliveries"
      />
    );
  }
  return (
    <SectionBoundary resetKey={envId}>
      <WebhookList
        onView={(next) => void navigate({ search: next === "all" ? { show: next } : {} })}
        scope={scope}
        view={view}
      />
    </SectionBoundary>
  );
}
