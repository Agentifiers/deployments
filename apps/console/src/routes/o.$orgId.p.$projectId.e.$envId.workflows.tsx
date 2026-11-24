import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import { Icon } from "../components/icon.tsx";
import { ListCreateAction } from "../components/list-create-action.tsx";
import { RouteTabs } from "../components/route-tabs.tsx";
import { CreateDefinitionDialog } from "../components/workflows/definition-actions.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import { environmentPath, type EnvironmentScope } from "../scope.ts";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import { Text } from "@/components/ui/text";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/workflows")({
  component: WorkflowsLayout,
});

function WorkflowsLayout() {
  const { envId, orgId, projectId } = Route.useParams();
  const { access } = useSuspenseQuery(organizationShellQuery(orgId)).data;
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  const [creating, setCreating] = useState(false);
  const basePath = `${environmentPath(scope)}/workflows`;
  const executionsTab = pathname.startsWith(`${basePath}/executions`);
  const approvalsTab = pathname.startsWith(`${basePath}/approvals`);
  const onDefinitionList = pathname === basePath || pathname === `${basePath}/`;
  const canCreate = access.listWorkflowDefinitions && access.createWorkflowDefinition;
  const create = canCreate ? (
    <Button onClick={() => setCreating(true)}>
      <Icon icon={PlusSignIcon} />
      Create workflow
    </Button>
  ) : undefined;
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <Heading>Workflows</Heading>
        {create && onDefinitionList ? <div className="ml-auto">{create}</div> : null}
      </div>
      <RouteTabs
        label="Workflow sections"
        tabs={[
          { current: !executionsTab && !approvalsTab, href: basePath, label: "Definitions" },
          { current: executionsTab, href: `${basePath}/executions`, label: "Executions" },
          { current: approvalsTab, href: `${basePath}/approvals`, label: "Approvals" },
        ]}
      />
      {access.listWorkflowDefinitions ? (
        <ListCreateAction value={create}>
          <Outlet />
        </ListCreateAction>
      ) : (
        <Text>Your role or token scopes do not permit reading workflows (workflows:read).</Text>
      )}
      {canCreate ? (
        <CreateDefinitionDialog onClose={() => setCreating(false)} open={creating} scope={scope} />
      ) : null}
    </div>
  );
}
