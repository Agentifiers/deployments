import { createFileRoute } from "@tanstack/react-router";
import { BackLink } from "../components/back-link.tsx";
import { MonitorDetail } from "../components/alerts/alert-details.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { incidentPagesQuery, monitorQuery } from "../data/alert-queries.ts";

export const Route = createFileRoute("/o/$orgId/alerts/monitors/$monitorId")({
  loader: ({ context, params }) => {
    void context.queryClient.prefetchQuery(monitorQuery(params.orgId, params.monitorId));
    void context.queryClient.prefetchInfiniteQuery(
      incidentPagesQuery({ organizationId: params.orgId }),
    );
  },
  component: Monitor,
});

function Monitor() {
  const { monitorId, orgId } = Route.useParams();
  return (
    <div className="flex flex-col gap-8">
      <BackLink href={`/o/${orgId}/alerts/monitors`} label="Monitors" />
      <SectionBoundary resetKey={monitorId}>
        <MonitorDetail monitorId={monitorId} organizationId={orgId} />
      </SectionBoundary>
    </div>
  );
}
