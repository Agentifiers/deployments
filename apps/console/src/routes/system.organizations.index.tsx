import { createFileRoute } from "@tanstack/react-router";
import { Heading } from "@/components/ui/heading";
import { Skeleton } from "@/components/ui/skeleton";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { SystemOrganizations } from "../components/system/system-organizations.tsx";
import { systemOrganizationsQuery } from "../data/console-queries.ts";

export const Route = createFileRoute("/system/organizations/")({
  loader: ({ context }) => {
    if (context.platformAdministrator) {
      void context.queryClient.prefetchInfiniteQuery(systemOrganizationsQuery());
    }
  },
  component: () => (
    <div className="space-y-6">
      <Heading>Organizations</Heading>
      <SectionBoundary fallback={<Skeleton className="h-32 rounded-lg" />} resetKey="organizations">
        <SystemOrganizations />
      </SectionBoundary>
    </div>
  ),
});
