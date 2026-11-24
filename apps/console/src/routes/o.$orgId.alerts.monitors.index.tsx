import { createFileRoute } from "@tanstack/react-router";
import { MonitorList } from "../components/alerts/alert-lists.tsx";
import { useListCreateAction } from "../components/list-create-action.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { monitorPagesQuery } from "../data/alert-queries.ts";

export const Route = createFileRoute("/o/$orgId/alerts/monitors/")({
  loader: ({ context, params }) => {
    void context.queryClient.prefetchInfiniteQuery(
      monitorPagesQuery({ organizationId: params.orgId }),
    );
  },
  component: Monitors,
});

function Monitors() {
  const { orgId } = Route.useParams();
  const create = useListCreateAction();
  return (
    <SectionBoundary resetKey={orgId}>
      <MonitorList createAction={create} list={{ organizationId: orgId }} />
    </SectionBoundary>
  );
}
