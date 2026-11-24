import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  AutomationList,
  type AutomationFilterPatch,
} from "../components/automations/automation-list.tsx";
import {
  CreateHeartbeatDialog,
  CreateScheduleDialog,
} from "../components/automations/automation-form-dialogs.tsx";
import { Icon } from "../components/icon.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { parseAutomationFilters, type AutomationFilters } from "../automations/automation-state.ts";
import { automationViewPagesQuery } from "../data/automation-queries.ts";
import { organizationShellQuery } from "../data/console-queries.ts";
import { agentDirectoryQuery } from "../data/observability-queries.ts";
import type { AutomationKind } from "../automations/automation-state.ts";
import type { EnvironmentScope } from "../scope.ts";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";

// Option order matters: `loader` infers `deps` only when `validateSearch` and `loaderDeps` precede it.
export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/automations/")({
  validateSearch: (search): AutomationFilters => parseAutomationFilters(search),
  loaderDeps: ({ search }) => parseAutomationFilters(search),
  loader: ({ context, deps, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    void context.queryClient.prefetchQuery(agentDirectoryQuery(scope));
    void context.queryClient.prefetchInfiniteQuery(
      automationViewPagesQuery(scope, { filters: deps, kind: "list" }),
    );
  },
  component: Automations,
});

function Automations() {
  const { envId, orgId, projectId } = Route.useParams();
  const filters = parseAutomationFilters(Route.useSearch());
  const navigate = Route.useNavigate();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  const {
    data: { access },
  } = useSuspenseQuery(organizationShellQuery(orgId));
  const [creating, setCreating] = useState<AutomationKind>();
  const filter = (patch: AutomationFilterPatch) =>
    void navigate({ resetScroll: false, search: parseAutomationFilters({ ...filters, ...patch }) });
  const createSchedule = access.createSchedule ? (
    <Button onClick={() => setCreating("schedule")}>
      <Icon icon={PlusSignIcon} />
      Create schedule
    </Button>
  ) : undefined;
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <Heading>Automations</Heading>
        <div className="ml-auto flex flex-wrap gap-3">
          {access.createHeartbeat ? (
            <Button onClick={() => setCreating("heartbeat")} variant="outline">
              <Icon icon={PlusSignIcon} />
              Create heartbeat
            </Button>
          ) : null}
          {createSchedule}
        </div>
      </div>
      <SectionBoundary resetKey={envId}>
        <AutomationList
          emptyAction={createSchedule}
          filters={filters}
          onFilter={filter}
          scope={scope}
        />
      </SectionBoundary>
      {creating === "schedule" ? (
        <CreateScheduleDialog onClose={() => setCreating(undefined)} scope={scope} />
      ) : null}
      {creating === "heartbeat" ? (
        <CreateHeartbeatDialog onClose={() => setCreating(undefined)} scope={scope} />
      ) : null}
    </div>
  );
}
