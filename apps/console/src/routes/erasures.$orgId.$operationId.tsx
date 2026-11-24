import { PUBLIC_ID_PATTERN } from "@deployments-ai/api-contract/primitives";
import { ArrowLeft02Icon } from "@hugeicons/core-free-icons";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { ErasureStatus } from "../components/governance/erasure-status.tsx";
import { Icon } from "../components/icon.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { SignOutButton } from "../components/sign-out.tsx";
import { erasureQuery } from "../data/governance-queries.ts";
import { Button } from "@/components/ui/button";

/**
 * Outside the organization layout on purpose: once the erasure completes, the organization and
 * every route but this erasure's GET answer 410, so the shell could no longer load.
 */
export const Route = createFileRoute("/erasures/$orgId/$operationId")({
  beforeLoad: ({ params }) => {
    if (![params.orgId, params.operationId].every((id) => PUBLIC_ID_PATTERN.test(id))) {
      throw notFound();
    }
  },
  loader: ({ context, params }) => {
    void context.queryClient.prefetchQuery(erasureQuery(params.orgId, params.operationId));
  },
  component: Erasure,
});

function Erasure() {
  const { operationId, orgId } = Route.useParams();
  return (
    <main className="mx-auto max-w-3xl space-y-6 p-6 lg:py-16">
      <div className="flex flex-wrap items-center gap-3">
        <Button href="/" variant="ghost">
          <Icon icon={ArrowLeft02Icon} />
          Organizations
        </Button>
        <div className="ml-auto">
          <SignOutButton />
        </div>
      </div>
      <SectionBoundary resetKey={operationId}>
        <ErasureStatus operationId={operationId} organizationId={orgId} />
      </SectionBoundary>
    </main>
  );
}
