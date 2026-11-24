import { createFileRoute } from "@tanstack/react-router";
import { BrainDocument } from "../components/brains/brain-document.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { brainDocumentQuery } from "../data/brain-queries.ts";

export const Route = createFileRoute(
  "/o/$orgId/p/$projectId/e/$envId/brains/$brainId/documents/$documentId",
)({
  loader: ({ context, params }) =>
    void context.queryClient.prefetchQuery(
      brainDocumentQuery(params.orgId, params.brainId, params.documentId),
    ),
  component: Document,
});

function Document() {
  const { brainId, documentId, orgId } = Route.useParams();
  return (
    <SectionBoundary resetKey={documentId}>
      <BrainDocument brainId={brainId} documentId={documentId} organizationId={orgId} />
    </SectionBoundary>
  );
}
