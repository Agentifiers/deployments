import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { createFileRoute } from "@tanstack/react-router";
import { BrainErasureReceipt } from "../components/brains/brain-erase.tsx";
import { Icon } from "../components/icon.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { brainErasureQuery } from "../data/brain-queries.ts";
import { environmentPath, type EnvironmentScope } from "../scope.ts";
import { Link } from "@/components/ui/link";

export const Route = createFileRoute(
  "/o/$orgId/p/$projectId/e/$envId/brains/$brainId_/erasures/$erasureId",
)({
  loader: ({ context, params }) =>
    void context.queryClient.prefetchQuery(
      brainErasureQuery(params.orgId, params.brainId, params.erasureId),
    ),
  component: Erasure,
});

function Erasure() {
  const { brainId, envId, erasureId, orgId, projectId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <div className="flex flex-col gap-6">
      <Link
        className="inline-flex w-fit items-center gap-1 text-sm/6 text-muted-foreground hover:text-foreground"
        href={`${environmentPath(scope)}/brains`}
      >
        <Icon className="size-4" icon={ArrowLeft01Icon} />
        Brains
      </Link>
      <SectionBoundary resetKey={erasureId}>
        <BrainErasureReceipt brainId={brainId} erasureId={erasureId} scope={scope} />
      </SectionBoundary>
    </div>
  );
}
