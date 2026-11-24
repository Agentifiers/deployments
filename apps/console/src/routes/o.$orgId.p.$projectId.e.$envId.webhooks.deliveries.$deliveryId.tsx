import { createFileRoute } from "@tanstack/react-router";
import { BackLink } from "../components/back-link.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { DeliveryDetail } from "../components/webhooks/delivery-detail.tsx";
import { deliveryQuery } from "../data/webhook-queries.ts";
import type { EnvironmentScope } from "../scope.ts";

export const Route = createFileRoute(
  "/o/$orgId/p/$projectId/e/$envId/webhooks/deliveries/$deliveryId",
)({
  loader: ({ context, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    void context.queryClient.prefetchQuery(deliveryQuery(scope, params.deliveryId));
  },
  component: Delivery,
});

function Delivery() {
  const { deliveryId, envId, orgId, projectId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <div className="flex flex-col gap-8">
      <BackLink
        href={`/o/${orgId}/p/${projectId}/e/${envId}/webhooks/deliveries`}
        label="Deliveries"
      />
      <SectionBoundary resetKey={deliveryId}>
        <DeliveryDetail deliveryId={deliveryId} scope={scope} />
      </SectionBoundary>
    </div>
  );
}
