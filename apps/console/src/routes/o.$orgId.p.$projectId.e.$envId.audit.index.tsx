import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { parseAuditSearch, type AuditFilters } from "../audit/audit-state.ts";
import { AuditLog } from "../components/audit/audit-log.tsx";
import { environmentAuditQuery } from "../data/audit-queries.ts";
import { organizationShellQuery } from "../data/console-queries.ts";
import type { EnvironmentScope } from "../scope.ts";
import { Heading } from "@/components/ui/heading";
import { Text } from "@/components/ui/text";

// Option order matters: `loader` infers `deps` only when `validateSearch` and `loaderDeps` precede it.
export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/audit/")({
  validateSearch: (search): AuditFilters => parseAuditSearch(search),
  loaderDeps: ({ search }) => parseAuditSearch(search),
  loader: async ({ context, deps, params }) => {
    const { access } = await context.queryClient.ensureQueryData(
      organizationShellQuery(params.orgId),
    );
    if (!access.listAuditEvents) return;
    const scope = {
      environmentId: params.envId,
      organizationId: params.orgId,
      projectId: params.projectId,
    };
    void context.queryClient.prefetchInfiniteQuery(environmentAuditQuery(scope, deps));
  },
  component: EnvironmentAudit,
});

function EnvironmentAudit() {
  const { envId, orgId, projectId } = Route.useParams();
  const { access } = useSuspenseQuery(organizationShellQuery(orgId)).data;
  const filters = parseAuditSearch(Route.useSearch());
  const navigate = Route.useNavigate();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  return (
    <div className="flex flex-col gap-6">
      <Heading>Audit log</Heading>
      {access.listAuditEvents ? (
        <AuditLog
          filters={filters}
          onFilters={(next) => void navigate({ search: next })}
          target={{ kind: "environment", scope }}
        />
      ) : (
        <Text>Your role or token scopes do not permit reading the audit log (audit:read).</Text>
      )}
    </div>
  );
}
