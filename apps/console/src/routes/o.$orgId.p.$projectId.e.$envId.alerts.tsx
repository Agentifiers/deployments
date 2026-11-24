import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { IncidentList, MonitorList } from "../components/alerts/alert-lists.tsx";
import { CreateMonitorDialog } from "../components/alerts/monitor-dialogs.tsx";
import { Icon } from "../components/icon.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { incidentPagesQuery, monitorPagesQuery } from "../data/alert-queries.ts";
import { organizationShellQuery } from "../data/console-queries.ts";
import { Button } from "@/components/ui/button";
import { Heading, Subheading } from "@/components/ui/heading";
import { Link } from "@/components/ui/link";
import { Text } from "@/components/ui/text";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/alerts")({
  loader: ({ context, params }) => {
    const list = { environmentId: params.envId, organizationId: params.orgId };
    void context.queryClient.prefetchInfiniteQuery(incidentPagesQuery(list));
    void context.queryClient.prefetchInfiniteQuery(monitorPagesQuery(list));
  },
  component: EnvironmentAlerts,
});

/** This environment's monitors and incidents; organization monitors live on the Alerts page. */
function EnvironmentAlerts() {
  const { envId, orgId } = Route.useParams();
  const { access } = useSuspenseQuery(organizationShellQuery(orgId)).data;
  const [creating, setCreating] = useState(false);
  const list = { environmentId: envId, organizationId: orgId };
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
      <Text>
        Monitors and incidents of this environment. Spend alerts and every environment&apos;s alerts
        are on the organization&apos;s <Link href={`/o/${orgId}/alerts`}>Alerts</Link> page.
      </Text>
      <section className="flex flex-col gap-3">
        <Subheading>Incidents</Subheading>
        <SectionBoundary resetKey={`incidents-${envId}`}>
          <IncidentList list={list} />
        </SectionBoundary>
      </section>
      <section className="flex flex-col gap-3">
        <Subheading>Monitors</Subheading>
        <SectionBoundary resetKey={`monitors-${envId}`}>
          <MonitorList createAction={create} list={list} />
        </SectionBoundary>
      </section>
      {access.createMonitor ? (
        <CreateMonitorDialog
          environmentId={envId}
          onClose={() => setCreating(false)}
          open={creating}
          organizationId={orgId}
        />
      ) : null}
    </div>
  );
}
