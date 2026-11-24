import { createFileRoute } from "@tanstack/react-router";
import { BackLink } from "../components/back-link.tsx";
import { AuditEventDetail } from "../components/audit/audit-event-detail.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { auditEventQuery } from "../data/audit-queries.ts";
import type { EnvironmentScope } from "../scope.ts";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/audit/$eventId")({
  loader: ({ context, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    void context.queryClient.prefetchQuery(auditEventQuery(scope, params.eventId));
  },
  component: AuditEvent,
});

function AuditEvent() {
  const { envId, eventId, orgId, projectId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <div className="flex flex-col gap-8">
      <BackLink href={`/o/${orgId}/p/${projectId}/e/${envId}/audit`} label="Audit log" />
      <SectionBoundary resetKey={eventId}>
        <AuditEventDetail eventId={eventId} scope={scope} />
      </SectionBoundary>
    </div>
  );
}
