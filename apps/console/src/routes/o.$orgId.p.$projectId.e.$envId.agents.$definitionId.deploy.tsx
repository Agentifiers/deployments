import { PUBLIC_ID_PATTERN } from "@deployments-ai/api-contract/primitives";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  DeployReleasePanel,
  type DeploySearch,
} from "../components/agents/bindings/deploy-release-panel.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import type { EnvironmentScope } from "../scope.ts";
import { Text } from "@/components/ui/text";

function parseDeploySearch(search: Readonly<Record<string, unknown>>): DeploySearch {
  const id = (value: unknown) =>
    typeof value === "string" && PUBLIC_ID_PATTERN.test(value) ? value : undefined;
  const release = id(search.release);
  const seed = id(search.seed);
  return { ...(release ? { release } : {}), ...(seed ? { seed } : {}) };
}

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/agents/$definitionId/deploy")(
  {
    validateSearch: parseDeploySearch,
    component: Deploy,
  },
);

function Deploy() {
  const { definitionId, envId, orgId, projectId } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const scope: EnvironmentScope = {
    environmentId: envId,
    organizationId: orgId,
    projectId,
  };
  const { access } = useSuspenseQuery(organizationShellQuery(orgId)).data;
  if (!access.createAgentDeployment) {
    return <Text>Your role or token scopes do not permit deploying agents (agents:write).</Text>;
  }
  return (
    <DeployReleasePanel
      definitionId={definitionId}
      onSearch={(next) => void navigate({ replace: true, search: next })}
      scope={scope}
      search={search}
    />
  );
}
