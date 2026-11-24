import { createFileRoute } from "@tanstack/react-router";
import { Heading } from "@/components/ui/heading";
import { Skeleton } from "@/components/ui/skeleton";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { SystemDeployments } from "../components/system/system-deployments.tsx";
import { systemDeploymentsQuery } from "../data/system-queries.ts";

export const Route = createFileRoute("/system/deployments")({
  loader: ({ context }) => {
    if (context.platformAdministrator) {
      void context.queryClient.prefetchInfiniteQuery(systemDeploymentsQuery());
    }
  },
  component: () => (
    <div className="space-y-6">
      <Heading>Deployments</Heading>
      <SectionBoundary fallback={<Skeleton className="h-40 rounded-lg" />} resetKey="deployments">
        <SystemDeployments />
      </SectionBoundary>
    </div>
  ),
});
