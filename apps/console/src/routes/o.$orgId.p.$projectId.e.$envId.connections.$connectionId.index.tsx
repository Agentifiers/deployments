import { createFileRoute } from "@tanstack/react-router";
import { BackLink } from "../components/back-link.tsx";
import { ConnectionDetail } from "../components/connections/connection-detail.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { connectionGrantsQuery } from "../data/agent-runtime-queries.ts";
import { organizationShellQuery } from "../data/console-queries.ts";
import {
  connectionDetailQuery,
  pinningDeploymentsQuery,
  workspacesQuery,
} from "../data/connection-queries.ts";
import type { EnvironmentScope } from "../scope.ts";

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;

export interface DetailSearch {
  readonly verification?: string;
}

function parseDetailSearch(search: Readonly<Record<string, unknown>>): DetailSearch {
  const { verification } = search;
  return typeof verification === "string" && ULID.test(verification) ? { verification } : {};
}

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/connections/$connectionId/")({
  validateSearch: (search): DetailSearch => parseDetailSearch(search),
  loader: async ({ context, params }) => {
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    const { access } = await context.queryClient.ensureQueryData(
      organizationShellQuery(params.orgId),
    );
    void context.queryClient.prefetchQuery(connectionDetailQuery(scope, params.connectionId));
    // ConnectionDetail reads these with useQuery, so a value streamed after SSR would make the
    // client's first render differ from the server HTML.
    await Promise.all([
      access.listConnectionGrants &&
        context.queryClient.prefetchQuery(connectionGrantsQuery(scope)),
      access.listAgentDeployments &&
        context.queryClient.prefetchQuery(pinningDeploymentsQuery(scope)),
      access.listWorkspaces && context.queryClient.prefetchQuery(workspacesQuery(scope)),
    ]);
  },
  component: Connection,
});

function Connection() {
  const { connectionId, envId, orgId, projectId } = Route.useParams();
  const { verification } = parseDetailSearch(Route.useSearch());
  const navigate = Route.useNavigate();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <div className="flex flex-col gap-8">
      <BackLink href={`/o/${orgId}/p/${projectId}/e/${envId}/connections`} label="Connections" />
      <SectionBoundary resetKey={connectionId}>
        <ConnectionDetail
          connectionId={connectionId}
          onVerified={(verificationId) =>
            void navigate({ search: { verification: verificationId } })
          }
          scope={scope}
          verificationId={verification}
        />
      </SectionBoundary>
    </div>
  );
}
