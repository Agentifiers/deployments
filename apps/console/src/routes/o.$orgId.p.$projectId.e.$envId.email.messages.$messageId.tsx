import { ClientOnly, createFileRoute } from "@tanstack/react-router";
import { MessageDetail } from "../components/email/mailbox/message-views.tsx";
import { SectionBoundary, SectionSkeleton } from "../components/section-boundary.tsx";
import type { EnvironmentScope } from "../scope.ts";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/email/messages/$messageId")({
  component: Message,
});

function Message() {
  const { envId, messageId, orgId, projectId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <ClientOnly fallback={<SectionSkeleton />}>
      <SectionBoundary resetKey={messageId}>
        <MessageDetail messageId={messageId} scope={scope} />
      </SectionBoundary>
    </ClientOnly>
  );
}
