import { createFileRoute } from "@tanstack/react-router";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { DeliveryFeed } from "../components/webhooks/delivery-table.tsx";
import { deliveryPagesQuery, endpointOptionsQuery } from "../data/webhook-queries.ts";
import type { EnvironmentScope } from "../scope.ts";
import { parseDeliveryFilters, type DeliveryFilters } from "../webhooks/webhook-state.ts";

// Option order matters: `loader` infers `deps` only when `validateSearch` and `loaderDeps` precede it.
export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/webhooks/deliveries/")({
  validateSearch: (search): DeliveryFilters => parseDeliveryFilters(search),
  loaderDeps: ({ search }) => parseDeliveryFilters(search),
  loader: ({ context, deps, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    void context.queryClient.prefetchInfiniteQuery(deliveryPagesQuery(scope, deps));
    void context.queryClient.prefetchQuery(endpointOptionsQuery(scope, deps.webhookId));
  },
  component: Deliveries,
});

function Deliveries() {
  const { envId, orgId, projectId } = Route.useParams();
  const filters = parseDeliveryFilters(Route.useSearch());
  const navigate = Route.useNavigate();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <SectionBoundary resetKey={envId}>
      <DeliveryFeed
        filters={filters}
        onFilters={(next) => void navigate({ search: next })}
        scope={scope}
      />
    </SectionBoundary>
  );
}
