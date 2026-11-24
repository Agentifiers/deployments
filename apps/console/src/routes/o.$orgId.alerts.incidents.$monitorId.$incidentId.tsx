import { createFileRoute } from "@tanstack/react-router";
import { BackLink } from "../components/back-link.tsx";
import { IncidentDetail } from "../components/alerts/alert-details.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { incidentQuery } from "../data/alert-queries.ts";

export const Route = createFileRoute("/o/$orgId/alerts/incidents/$monitorId/$incidentId")({
  loader: ({ context, params }) => {
    void context.queryClient.prefetchQuery(
      incidentQuery(params.orgId, params.monitorId, params.incidentId),
    );
  },
  component: Incident,
});

function Incident() {
  const { incidentId, monitorId, orgId } = Route.useParams();
  return (
    <div className="flex flex-col gap-8">
      <BackLink href={`/o/${orgId}/alerts`} label="Incidents" />
      <SectionBoundary resetKey={incidentId}>
        <IncidentDetail incidentId={incidentId} monitorId={monitorId} organizationId={orgId} />
      </SectionBoundary>
    </div>
  );
}
