import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Icon } from "../components/icon.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { CreateWorkspaceDialog } from "../components/workspaces/workspace-dialog.tsx";
import { WorkspaceTable } from "../components/workspaces/workspace-table.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import { workspacesQuery } from "../data/connection-queries.ts";
import type { EnvironmentScope } from "../scope.ts";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import { Text } from "@/components/ui/text";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/workspaces/")({
  loader: async ({ context, params }) => {
    const { access } = await context.queryClient.ensureQueryData(
      organizationShellQuery(params.orgId),
    );
    if (access.listWorkspaces) {
      void context.queryClient.prefetchQuery(
        workspacesQuery({
          environmentId: params.envId,
          organizationId: params.orgId,
          projectId: params.projectId,
        }),
      );
    }
  },
  component: Workspaces,
});

function Workspaces() {
  const { envId, orgId, projectId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  const { data: shell } = useSuspenseQuery(organizationShellQuery(orgId));
  const { access } = shell;
  const [creating, setCreating] = useState(false);
  const create = access.createWorkspace ? (
    <Button onClick={() => setCreating(true)}>
      <Icon icon={PlusSignIcon} />
      Create workspace
    </Button>
  ) : undefined;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <Heading>Workspaces</Heading>
        {create ? <div className="ml-auto">{create}</div> : null}
      </div>
      {access.listWorkspaces ? (
        <SectionBoundary resetKey={envId}>
          <WorkspaceTable emptyAction={create} scope={scope} />
        </SectionBoundary>
      ) : (
        <Text>Your role or token scopes do not permit listing workspaces (workspaces:read).</Text>
      )}
      {access.createWorkspace ? (
        <CreateWorkspaceDialog onClose={() => setCreating(false)} open={creating} scope={scope} />
      ) : null}
    </div>
  );
}
