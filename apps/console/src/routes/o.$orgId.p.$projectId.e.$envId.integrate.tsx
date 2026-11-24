import { PUBLIC_ID_PATTERN } from "@deployments-ai/api-contract/primitives";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { IntegratePage } from "../components/integrations/integrate-page.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { deploymentTargetsQuery } from "../data/agent-email-inbox-queries.ts";
import { organizationShellQuery } from "../data/console-queries.ts";
import { integrationEndpointsQuery } from "../data/integration-queries.ts";
import type { EnvironmentScope } from "../scope.ts";
import { Heading } from "@/components/ui/heading";
import { Text } from "@/components/ui/text";

export interface IntegrateSearch {
  readonly deployment?: string;
}

function parseIntegrateSearch(search: Readonly<Record<string, unknown>>): IntegrateSearch {
  const { deployment } = search;
  return typeof deployment === "string" && PUBLIC_ID_PATTERN.test(deployment) ? { deployment } : {};
}

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/integrate")({
  validateSearch: parseIntegrateSearch,
  loader: async ({ context, params }) => {
    const scope: EnvironmentScope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    const [{ access }] = await Promise.all([
      context.queryClient.ensureQueryData(organizationShellQuery(params.orgId)),
      context.queryClient.ensureQueryData(integrationEndpointsQuery()),
    ]);
    if (access.listAgentDeployments) {
      void context.queryClient.prefetchQuery(deploymentTargetsQuery(scope));
    }
  },
  component: Integrate,
});

function Integrate() {
  const { envId, orgId, projectId } = Route.useParams();
  const { deployment } = Route.useSearch();
  const navigate = Route.useNavigate();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  const { data: shell } = useSuspenseQuery(organizationShellQuery(orgId));
  const { data: endpoints } = useSuspenseQuery(integrationEndpointsQuery());
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-1">
        <Heading>Integrate</Heading>
        <Text>
          Connect your own product to this environment: send work in through the API, stream the
          output, and receive events.
        </Text>
      </div>
      <SectionBoundary resetKey={envId}>
        <IntegratePage
          access={shell.access}
          deploymentId={deployment}
          endpoints={endpoints}
          onDeployment={(next) =>
            void navigate({ replace: true, search: next ? { deployment: next } : {} })
          }
          scope={scope}
        />
      </SectionBoundary>
    </div>
  );
}
