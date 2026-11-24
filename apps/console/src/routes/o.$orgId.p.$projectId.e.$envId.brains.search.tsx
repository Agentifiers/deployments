import { createFileRoute } from "@tanstack/react-router";
import { parseQuerySearch } from "../brains/query.ts";
import { BrainQuery } from "../components/brains/brain-query.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { brainListQuery } from "../data/brain-queries.ts";
import type { EnvironmentScope } from "../scope.ts";
import { Heading } from "@/components/ui/heading";
import { Text } from "@/components/ui/text";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/brains/search")({
  validateSearch: parseQuerySearch,
  loader: ({ context, params }) =>
    void context.queryClient.prefetchInfiniteQuery(brainListQuery(params.orgId)),
  component: BrainSearch,
});

function BrainSearch() {
  const { envId, orgId, projectId } = Route.useParams();
  const { brainId } = Route.useSearch();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <div className="flex flex-col gap-8">
      <div>
        <Heading>Search Brains</Heading>
        <Text>
          Search returns cited excerpts from the Brains you choose, and Ask answers a question from
          them. Both run only when you submit, and usage counts in this environment.
        </Text>
      </div>
      <SectionBoundary resetKey={orgId}>
        <BrainQuery preselected={brainId} scope={scope} />
      </SectionBoundary>
    </div>
  );
}
