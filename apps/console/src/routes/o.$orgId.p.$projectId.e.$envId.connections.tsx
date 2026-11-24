import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import { AddConnectionDialog } from "../components/connections/credential-dialogs.tsx";
import { Icon } from "../components/icon.tsx";
import { ListCreateAction } from "../components/list-create-action.tsx";
import { RouteTabs, type RouteTab } from "../components/route-tabs.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import { environmentPath, type EnvironmentScope } from "../scope.ts";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/connections")({
  component: ConnectionsLayout,
});

function ConnectionsLayout() {
  const { envId, orgId, projectId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { data: shell } = useSuspenseQuery(organizationShellQuery(orgId));
  const { access } = shell;
  const [adding, setAdding] = useState(false);
  const connectionsPath = `${environmentPath(scope)}/connections`;
  const appsPath = `${connectionsPath}/oauth-apps`;
  const onApps = pathname === appsPath;
  const tabs: readonly RouteTab[] = [
    { current: !onApps, href: connectionsPath, label: "Connections" },
    ...(access.listProviderApplications
      ? [{ current: onApps, href: appsPath, label: "OAuth apps" }]
      : []),
  ];

  const add = access.createProviderCredential ? (
    <Button onClick={() => setAdding(true)}>
      <Icon icon={PlusSignIcon} />
      Add connection
    </Button>
  ) : undefined;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <Heading>Connections</Heading>
        {add && !onApps ? <div className="ml-auto">{add}</div> : null}
      </div>
      <RouteTabs label="Connection sections" tabs={tabs} />
      <ListCreateAction value={add}>
        <Outlet />
      </ListCreateAction>
      {access.createProviderCredential ? (
        <AddConnectionDialog
          canAuthorize={access.beginProviderAuthorization}
          onClose={() => setAdding(false)}
          open={adding}
          scope={scope}
        />
      ) : null}
    </div>
  );
}
