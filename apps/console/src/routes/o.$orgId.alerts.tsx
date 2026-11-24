import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import { AlertsNotReadable } from "../components/alerts/alerts-not-readable.tsx";
import { CreateMonitorDialog } from "../components/alerts/monitor-dialogs.tsx";
import { Icon } from "../components/icon.tsx";
import { ListCreateAction } from "../components/list-create-action.tsx";
import { RouteTabs } from "../components/route-tabs.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";

export const Route = createFileRoute("/o/$orgId/alerts")({
  component: AlertsLayout,
});

function AlertsLayout() {
  const { orgId } = Route.useParams();
  const { access } = useSuspenseQuery(organizationShellQuery(orgId)).data;
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const [creating, setCreating] = useState(false);
  const base = `/o/${orgId}/alerts`;
  const within = (path: string) => pathname === path || pathname.startsWith(`${path}/`);
  const onMonitors = within(`${base}/monitors`);
  const onSettings = within(`${base}/settings`);
  const tabs = [
    ...(access.listAlertIncidents
      ? [{ current: !onMonitors && !onSettings, href: base, label: "Incidents" }]
      : []),
    ...(access.listMonitors
      ? [{ current: onMonitors, href: `${base}/monitors`, label: "Monitors" }]
      : []),
    ...(access.getAlertNotificationPreferences
      ? [{ current: onSettings, href: `${base}/settings`, label: "Email settings" }]
      : []),
  ];
  const create = access.createMonitor ? (
    <Button onClick={() => setCreating(true)}>
      <Icon icon={PlusSignIcon} />
      Create monitor
    </Button>
  ) : undefined;
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <Heading>Alerts</Heading>
        {create ? <div className="ml-auto">{create}</div> : null}
      </div>
      {access.listMonitors ? (
        <>
          <RouteTabs label="Alert sections" tabs={tabs} />
          <ListCreateAction value={create}>
            <Outlet />
          </ListCreateAction>
        </>
      ) : (
        <SectionBoundary fallback={null} resetKey={orgId}>
          <AlertsNotReadable organizationId={orgId} />
        </SectionBoundary>
      )}
      {access.createMonitor ? (
        <CreateMonitorDialog
          onClose={() => setCreating(false)}
          open={creating}
          organizationId={orgId}
        />
      ) : null}
    </div>
  );
}
