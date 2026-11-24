import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { Icon } from "../components/icon.tsx";
import { ListCreateAction } from "../components/list-create-action.tsx";
import { RouteTabs } from "../components/route-tabs.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import { environmentPath } from "../scope.ts";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/tool-policies")({
  component: ToolPoliciesLayout,
});

function ToolPoliciesLayout() {
  const { envId, orgId, projectId } = Route.useParams();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { access } = useSuspenseQuery(organizationShellQuery(orgId)).data;
  const basePath = `${environmentPath({ environmentId: envId, organizationId: orgId, projectId })}/tool-policies`;
  const catalogPath = `${basePath}/catalog`;
  const simulatePath = `${basePath}/simulate`;
  const tabs = [
    ...(access.listToolPolicies
      ? [
          {
            current: pathname !== catalogPath && pathname !== simulatePath,
            href: basePath,
            label: "Policies",
          },
        ]
      : []),
    ...(access.listTools
      ? [{ current: pathname === catalogPath, href: catalogPath, label: "Catalog" }]
      : []),
    ...(access.evaluateToolPolicy
      ? [{ current: pathname === simulatePath, href: simulatePath, label: "Simulate" }]
      : []),
  ];
  const create = access.createToolPolicy ? (
    <Button href={`${basePath}/new`}>
      <Icon icon={PlusSignIcon} />
      Create policy
    </Button>
  ) : undefined;
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <Heading>Tool policies</Heading>
        {create ? <div className="ml-auto">{create}</div> : null}
      </div>
      <RouteTabs label="Tool policy sections" tabs={tabs} />
      <ListCreateAction value={create}>
        <Outlet />
      </ListCreateAction>
    </div>
  );
}
