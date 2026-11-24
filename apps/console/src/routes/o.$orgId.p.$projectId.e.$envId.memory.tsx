import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import { Icon } from "../components/icon.tsx";
import { ListCreateAction } from "../components/list-create-action.tsx";
import { CreateSpaceDialog } from "../components/memory/space-dialogs.tsx";
import { RouteTabs } from "../components/route-tabs.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import type { ConsoleOperation } from "../access.ts";
import { environmentPath, type EnvironmentScope } from "../scope.ts";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";

const MEMORY_TABS = [
  { gate: "listMemorySpaces", label: "Spaces", segment: "" },
  { gate: "listMemoryReviewItems", label: "Review", segment: "/review" },
  { gate: "searchMemories", label: "Search", segment: "/search" },
  { gate: "getMemoryQuality", label: "Quality", segment: "/quality" },
  { gate: "listMemoryPolicies", label: "Policies", segment: "/policies" },
] as const satisfies readonly {
  gate: ConsoleOperation;
  label: string;
  segment: string;
}[];

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/memory")({
  component: MemoryLayout,
});

function MemoryLayout() {
  const { envId, orgId, projectId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { data: shell } = useSuspenseQuery(organizationShellQuery(orgId));
  const { access } = shell;
  const [creating, setCreating] = useState(false);
  const basePath = `${environmentPath(scope)}/memory`;
  const onSpaceList = pathname === basePath || pathname === `${basePath}/`;
  const current = MEMORY_TABS.findLast(
    (tab) => tab.segment === "" || pathname.startsWith(`${basePath}${tab.segment}`),
  );
  const tabs = MEMORY_TABS.filter((tab) => access[tab.gate]).map((tab) => ({
    current: tab === current,
    href: `${basePath}${tab.segment}`,
    label: tab.label,
  }));

  const create = access.createMemorySpace ? (
    <Button onClick={() => setCreating(true)}>
      <Icon icon={PlusSignIcon} />
      Create space
    </Button>
  ) : undefined;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <Heading>Memory</Heading>
        {create && onSpaceList ? <div className="ml-auto">{create}</div> : null}
      </div>
      <RouteTabs label="Memory sections" tabs={tabs} />
      <ListCreateAction value={create}>
        <Outlet />
      </ListCreateAction>
      {access.createMemorySpace ? (
        <CreateSpaceDialog onClose={() => setCreating(false)} open={creating} scope={scope} />
      ) : null}
    </div>
  );
}
