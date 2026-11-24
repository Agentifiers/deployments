import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ModelPolicyForm } from "../components/models/model-policy-form.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import { activeModelPolicyQuery } from "../data/model-queries.ts";
import type { EnvironmentScope } from "../scope.ts";
import { Text } from "@/components/ui/text";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/models/policy/edit")({
  loader: async ({ context, params }) => {
    const { access } = await context.queryClient.ensureQueryData(
      organizationShellQuery(params.orgId),
    );
    if (access.listModels && (access.createModelPolicy || access.updateModelPolicy)) {
      void context.queryClient.prefetchQuery(
        activeModelPolicyQuery({
          environmentId: params.envId,
          organizationId: params.orgId,
          projectId: params.projectId,
        }),
      );
    }
  },
  component: EditModelPolicy,
});

function EditModelPolicy() {
  const { envId, orgId, projectId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  const { access } = useSuspenseQuery(organizationShellQuery(orgId)).data;
  if (!access.createModelPolicy && !access.updateModelPolicy) {
    return (
      <Text>Your role or token scopes do not permit changing the model policy (models:write).</Text>
    );
  }
  return (
    <SectionBoundary resetKey={envId}>
      <ModelPolicyForm scope={scope} />
    </SectionBoundary>
  );
}
