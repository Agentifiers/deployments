import { createFileRoute } from "@tanstack/react-router";
import { Heading } from "@/components/ui/heading";
import { Skeleton } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { OperatorAccessList } from "../components/system/operator-access.tsx";
import { systemOperatorAccessQuery } from "../data/system-queries.ts";

export const Route = createFileRoute("/system/operator-access")({
  loader: ({ context }) => {
    if (context.platformAdministrator) {
      void context.queryClient.prefetchInfiniteQuery(systemOperatorAccessQuery());
    }
  },
  component: () => (
    <div className="space-y-6">
      <Heading>Operator access</Heading>
      <Text>
        Platform administrators who can read and change an organization's data right now. Each
        organization sees its own in its audit log. Open or close your access from the
        organization's page.
      </Text>
      <SectionBoundary
        fallback={<Skeleton className="h-32 rounded-lg" />}
        resetKey="operator-access"
      >
        <OperatorAccessList />
      </SectionBoundary>
    </div>
  ),
});
