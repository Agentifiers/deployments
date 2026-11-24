import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { PolicySimulator } from "../components/tool-policies/policy-simulator.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import {
  policyOptionsQuery,
  policyPinsQuery,
  simulationQuery,
} from "../data/tool-policy-queries.ts";
import type { EnvironmentScope } from "../scope.ts";
import {
  parseSimulationSearch,
  simulationInput,
  type SimulationSearch,
} from "../tool-policies/simulator-state.ts";
import { Text } from "@/components/ui/text";

// Option order matters: `loader` infers `deps` only when `validateSearch` and `loaderDeps` precede it.
export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/tool-policies/simulate")({
  validateSearch: (search): SimulationSearch => parseSimulationSearch(search),
  loaderDeps: ({ search }) => parseSimulationSearch(search),
  loader: async ({ context, deps, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    const { access } = await context.queryClient.ensureQueryData(
      organizationShellQuery(params.orgId),
    );
    if (!access.evaluateToolPolicy) return;
    if (deps.against === "deployment" && access.listAgentDeployments) {
      void context.queryClient.prefetchQuery(policyPinsQuery(scope));
    } else if (access.listToolPolicies) {
      void context.queryClient.prefetchQuery(policyOptionsQuery(scope));
    }
    if (simulationInput(deps)) void context.queryClient.prefetchQuery(simulationQuery(scope, deps));
  },
  component: Simulate,
});

function Simulate() {
  const { envId, orgId, projectId } = Route.useParams();
  const search = parseSimulationSearch(Route.useSearch());
  const navigate = Route.useNavigate();
  const { access } = useSuspenseQuery(organizationShellQuery(orgId)).data;
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  if (!access.evaluateToolPolicy || !access.listToolPolicies) {
    return (
      <Text>Your role or token scopes do not permit simulating tool policies (tools:read).</Text>
    );
  }
  return (
    <SectionBoundary resetKey={envId}>
      <PolicySimulator
        canListDeployments={access.listAgentDeployments}
        onSearch={(next) => void navigate({ search: next })}
        scope={scope}
        search={search}
      />
    </SectionBoundary>
  );
}
