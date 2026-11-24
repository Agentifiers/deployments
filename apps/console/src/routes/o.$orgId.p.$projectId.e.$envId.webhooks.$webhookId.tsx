import { createFileRoute } from "@tanstack/react-router";
import { BackLink } from "../components/back-link.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { WebhookDetail } from "../components/webhooks/webhook-detail.tsx";
import { deliveryPagesQuery, webhookQuery } from "../data/webhook-queries.ts";
import type { EnvironmentScope } from "../scope.ts";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/webhooks/$webhookId")({
  loader: ({ context, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    void context.queryClient.prefetchQuery(webhookQuery(scope, params.webhookId));
    void context.queryClient.prefetchInfiniteQuery(
      deliveryPagesQuery(scope, { webhookId: params.webhookId }),
    );
  },
  component: Endpoint,
});

function Endpoint() {
  const { envId, orgId, projectId, webhookId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <div className="flex flex-col gap-8">
      <BackLink href={`/o/${orgId}/p/${projectId}/e/${envId}/webhooks`} label="Endpoints" />
      <SectionBoundary resetKey={webhookId}>
        <WebhookDetail scope={scope} webhookId={webhookId} />
      </SectionBoundary>
    </div>
  );
}
