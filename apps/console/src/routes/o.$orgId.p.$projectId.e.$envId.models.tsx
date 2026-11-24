import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { RouteTabs, type RouteTab } from "../components/route-tabs.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import { environmentPath } from "../scope.ts";
import { Heading } from "@/components/ui/heading";
import { Text } from "@/components/ui/text";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/models")({
  component: ModelsLayout,
});

function ModelsLayout() {
  const { envId, orgId, projectId } = Route.useParams();
  const { access } = useSuspenseQuery(organizationShellQuery(orgId)).data;
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const modelsPath = `${environmentPath({ environmentId: envId, organizationId: orgId, projectId })}/models`;
  const policyPath = `${modelsPath}/policy`;
  const onPolicy = pathname.startsWith(policyPath);
  const tabs: readonly RouteTab[] = [
    { current: !onPolicy, href: modelsPath, label: "Catalog" },
    { current: onPolicy, href: policyPath, label: "Policy" },
  ];
  return (
    <div className="flex flex-col gap-8">
      <Heading>Models</Heading>
      <RouteTabs label="Model sections" tabs={tabs} />
      {access.listModels ? (
        <Outlet />
      ) : (
        <Text>Your role or token scopes do not permit listing models (models:read).</Text>
      )}
    </div>
  );
}
