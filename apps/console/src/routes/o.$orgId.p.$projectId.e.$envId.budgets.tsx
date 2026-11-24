import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import { CreateBudgetDialog } from "../components/budgets/budget-dialogs.tsx";
import { Icon } from "../components/icon.tsx";
import { ListCreateAction } from "../components/list-create-action.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import { environmentPath, type EnvironmentScope } from "../scope.ts";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/budgets")({
  component: BudgetsLayout,
});

function BudgetsLayout() {
  const { envId, orgId, projectId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  const { data: shell } = useSuspenseQuery(organizationShellQuery(orgId));
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [creating, setCreating] = useState(false);
  const basePath = `${environmentPath(scope)}/budgets`;
  const onList = pathname === basePath || pathname === `${basePath}/`;
  const create = shell.access.createBudget ? (
    <Button onClick={() => setCreating(true)}>
      <Icon icon={PlusSignIcon} />
      Create budget
    </Button>
  ) : undefined;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <Heading>Budgets</Heading>
        {create && onList ? <div className="ml-auto">{create}</div> : null}
      </div>
      <ListCreateAction value={create}>
        <Outlet />
      </ListCreateAction>
      {shell.access.createBudget ? (
        <CreateBudgetDialog onClose={() => setCreating(false)} open={creating} scope={scope} />
      ) : null}
    </div>
  );
}
