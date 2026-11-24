import { createFileRoute } from "@tanstack/react-router";
import { parseEraseSearch } from "../brains/erasure.ts";
import { EraseBrain } from "../components/brains/brain-erase.tsx";

/** Outside the Brain layout: an archived Brain's `getBrain` is refused, so the layout cannot load. */
export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/brains/$brainId_/erase")({
  validateSearch: parseEraseSearch,
  component: Erase,
});

function Erase() {
  const { brainId, envId, orgId, projectId } = Route.useParams();
  const { version } = Route.useSearch();
  return (
    <EraseBrain
      brainId={brainId}
      scope={{ environmentId: envId, organizationId: orgId, projectId }}
      version={version}
    />
  );
}
