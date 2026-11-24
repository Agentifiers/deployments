import { PUBLIC_ID_PATTERN } from "@deployments-ai/api-contract/primitives";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { Skeleton } from "@/components/ui/skeleton";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { PersonDetail } from "../components/system/person-detail.tsx";
import { sessionIdentityQuery } from "../data/console-queries.ts";
import { systemPersonQuery, systemSecurityEventsQuery } from "../data/system-queries.ts";

export const Route = createFileRoute("/system/people/$principalId")({
  beforeLoad: ({ params }) => {
    if (!PUBLIC_ID_PATTERN.test(params.principalId)) throw notFound();
  },
  loader: async ({ context, params }) => {
    if (!context.platformAdministrator) return;
    void context.queryClient.prefetchInfiniteQuery(systemSecurityEventsQuery(params.principalId));
    await context.queryClient.ensureQueryData(systemPersonQuery(params.principalId));
  },
  component: Person,
});

function Person() {
  const { principalId } = Route.useParams();
  const { data: identity } = useQuery(sessionIdentityQuery());
  return (
    <SectionBoundary fallback={<Skeleton className="h-96 rounded-lg" />} resetKey={principalId}>
      <PersonDetail principalId={principalId} selfPrincipalId={identity?.principalId} />
    </SectionBoundary>
  );
}
