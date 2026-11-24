import { PUBLIC_ID_PATTERN } from "@deployments-ai/api-contract/primitives";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { BackLink } from "../components/back-link.tsx";
import { ExportDetail } from "../components/governance/export-detail.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { exportQuery } from "../data/governance-queries.ts";
import { exportKindOf } from "../governance/operation-state.ts";

export const Route = createFileRoute("/o/$orgId/governance/$kind/$operationId")({
  beforeLoad: ({ params }) => {
    const kind = exportKindOf(params.kind);
    if (kind === undefined || !PUBLIC_ID_PATTERN.test(params.operationId)) throw notFound();
    return { kind };
  },
  loader: ({ context, params }) => {
    void context.queryClient.prefetchQuery(
      exportQuery(params.orgId, context.kind, params.operationId),
    );
  },
  component: Export,
});

function Export() {
  const { operationId, orgId } = Route.useParams();
  const { kind } = Route.useRouteContext();
  return (
    <div className="flex flex-col gap-8">
      <BackLink href={`/o/${orgId}/governance`} label="Data governance" />
      <SectionBoundary resetKey={operationId}>
        <ExportDetail kind={kind} operationId={operationId} organizationId={orgId} />
      </SectionBoundary>
    </div>
  );
}
