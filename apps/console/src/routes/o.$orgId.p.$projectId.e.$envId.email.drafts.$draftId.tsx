import { ClientOnly, createFileRoute } from "@tanstack/react-router";
import { DraftDetail } from "../components/email/mailbox/draft-views.tsx";
import { SectionBoundary, SectionSkeleton } from "../components/section-boundary.tsx";
import type { EnvironmentScope } from "../scope.ts";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/email/drafts/$draftId")({
  component: Draft,
});

function Draft() {
  const { draftId, envId, orgId, projectId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <ClientOnly fallback={<SectionSkeleton />}>
      <SectionBoundary resetKey={draftId}>
        <DraftDetail draftId={draftId} scope={scope} />
      </SectionBoundary>
    </ClientOnly>
  );
}
