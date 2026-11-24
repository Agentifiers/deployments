import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { BrainSettings } from "../components/brains/brain-settings.tsx";
import { brainViewQuery } from "../data/brain-queries.ts";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/brains/$brainId/settings")({
  component: Settings,
});

function Settings() {
  const { brainId, envId, orgId, projectId } = Route.useParams();
  const { data: view } = useSuspenseQuery(brainViewQuery(orgId, brainId));
  return (
    <BrainSettings scope={{ environmentId: envId, organizationId: orgId, projectId }} view={view} />
  );
}
