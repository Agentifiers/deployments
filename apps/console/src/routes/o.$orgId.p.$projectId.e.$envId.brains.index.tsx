import { PlusSignIcon, Search01Icon } from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { canCreateBrain } from "../brains/model.ts";
import { BrainList, CreateBrainDialog } from "../components/brains/brain-list.tsx";
import { Icon } from "../components/icon.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { brainListQuery } from "../data/brain-queries.ts";
import { organizationShellQuery } from "../data/console-queries.ts";
import { environmentPath, type EnvironmentScope } from "../scope.ts";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import { Text } from "@/components/ui/text";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/brains/")({
  loader: ({ context, params }) =>
    void context.queryClient.prefetchInfiniteQuery(brainListQuery(params.orgId)),
  component: Brains,
});

function Brains() {
  const { envId, orgId, projectId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  const { data: shell } = useSuspenseQuery(organizationShellQuery(orgId));
  const [creating, setCreating] = useState(false);
  const creatable = shell.access.createBrain && canCreateBrain(shell.authorization);
  const create = creatable ? (
    <Button onClick={() => setCreating(true)}>
      <Icon icon={PlusSignIcon} />
      Create Brain
    </Button>
  ) : undefined;
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <Heading>Brains</Heading>
          <Text>
            Brains belong to the organization. The same Brains appear in every project and
            environment.
          </Text>
        </div>
        <div className="ml-auto flex flex-wrap gap-3">
          {shell.access.searchBrains ? (
            <Button href={`${environmentPath(scope)}/brains/search`} variant="outline">
              <Icon icon={Search01Icon} />
              Search and ask
            </Button>
          ) : null}
          {create}
        </div>
      </div>
      <SectionBoundary resetKey={orgId}>
        <BrainList emptyAction={create} scope={scope} />
      </SectionBoundary>
      {creatable ? (
        <CreateBrainDialog
          authorization={shell.authorization}
          onClose={() => setCreating(false)}
          open={creating}
          scope={scope}
        />
      ) : null}
    </div>
  );
}
