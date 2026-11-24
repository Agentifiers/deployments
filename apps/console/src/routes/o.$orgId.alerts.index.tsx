import { createFileRoute } from "@tanstack/react-router";
import { IncidentList } from "../components/alerts/alert-lists.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { incidentPagesQuery } from "../data/alert-queries.ts";

export const Route = createFileRoute("/o/$orgId/alerts/")({
  loader: ({ context, params }) => {
    void context.queryClient.prefetchInfiniteQuery(
      incidentPagesQuery({ organizationId: params.orgId }),
    );
  },
  component: AlertIncidents,
});

function AlertIncidents() {
  const { orgId } = Route.useParams();
  return (
    <SectionBoundary resetKey={orgId}>
      <IncidentList list={{ organizationId: orgId }} />
    </SectionBoundary>
  );
}
