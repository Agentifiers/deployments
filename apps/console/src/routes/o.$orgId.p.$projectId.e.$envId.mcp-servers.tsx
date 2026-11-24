import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useState } from "react";
import { Icon } from "../components/icon.tsx";
import { ListCreateAction } from "../components/list-create-action.tsx";
import { CreateMcpServerDialog } from "../components/mcp/mcp-server-dialogs.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import type { EnvironmentScope } from "../scope.ts";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/mcp-servers")({
  component: McpServersLayout,
});

function McpServersLayout() {
  const { envId, orgId, projectId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  const { data: shell } = useSuspenseQuery(organizationShellQuery(orgId));
  const { access } = shell;
  const [creating, setCreating] = useState(false);
  const create = access.createMcpServer ? (
    <Button onClick={() => setCreating(true)}>
      <Icon icon={PlusSignIcon} />
      Register server
    </Button>
  ) : undefined;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <Heading>MCP servers</Heading>
        {create ? <div className="ml-auto">{create}</div> : null}
      </div>
      <ListCreateAction value={create}>
        <Outlet />
      </ListCreateAction>
      {access.createMcpServer ? (
        <CreateMcpServerDialog onClose={() => setCreating(false)} open={creating} scope={scope} />
      ) : null}
    </div>
  );
}
