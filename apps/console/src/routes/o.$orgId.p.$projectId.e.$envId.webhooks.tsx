import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import { Icon } from "../components/icon.tsx";
import { ListCreateAction } from "../components/list-create-action.tsx";
import { RouteTabs } from "../components/route-tabs.tsx";
import { CreateWebhookDialog } from "../components/webhooks/webhook-dialogs.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import { environmentPath, type EnvironmentScope } from "../scope.ts";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/webhooks")({
  component: WebhooksLayout,
});

function WebhooksLayout() {
  const { envId, orgId, projectId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { data: shell } = useSuspenseQuery(organizationShellQuery(orgId));
  const { access } = shell;
  const [creating, setCreating] = useState(false);
  const basePath = `${environmentPath(scope)}/webhooks`;
  const deliveriesPath = `${basePath}/deliveries`;
  const onDeliveries = pathname === deliveriesPath || pathname.startsWith(`${deliveriesPath}/`);
  const onEndpointList = pathname === basePath || pathname === `${basePath}/`;
  const tabs = [
    ...(access.listWebhooks
      ? [{ current: !onDeliveries, href: basePath, label: "Endpoints" }]
      : []),
    ...(access.listWebhookDeliveries
      ? [{ current: onDeliveries, href: deliveriesPath, label: "Deliveries" }]
      : []),
  ];

  const create = access.createWebhook ? (
    <Button onClick={() => setCreating(true)}>
      <Icon icon={PlusSignIcon} />
      Create endpoint
    </Button>
  ) : undefined;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <Heading>Webhooks</Heading>
        {create && onEndpointList ? <div className="ml-auto">{create}</div> : null}
      </div>
      <RouteTabs label="Webhook sections" tabs={tabs} />
      <ListCreateAction value={create}>
        <Outlet />
      </ListCreateAction>
      {access.createWebhook ? (
        <CreateWebhookDialog onClose={() => setCreating(false)} open={creating} scope={scope} />
      ) : null}
    </div>
  );
}
