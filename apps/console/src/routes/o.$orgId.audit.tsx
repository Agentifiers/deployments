import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { parseAuditSearch, type AuditFilters } from "../audit/audit-state.ts";
import { AuditLog } from "../components/audit/audit-log.tsx";
import { organizationAuditQuery } from "../data/audit-queries.ts";
import { organizationShellQuery } from "../data/console-queries.ts";
import { Heading } from "@/components/ui/heading";
import { Text } from "@/components/ui/text";

// Option order matters: `loader` infers `deps` only when `validateSearch` and `loaderDeps` precede it.
export const Route = createFileRoute("/o/$orgId/audit")({
  validateSearch: (search): AuditFilters => parseAuditSearch(search),
  loaderDeps: ({ search }) => parseAuditSearch(search),
  loader: async ({ context, deps, params }) => {
    const { access } = await context.queryClient.ensureQueryData(
      organizationShellQuery(params.orgId),
    );
    if (access.listOrganizationAuditEvents) {
      void context.queryClient.prefetchInfiniteQuery(organizationAuditQuery(params.orgId, deps));
    }
  },
  component: OrganizationAudit,
});

function OrganizationAudit() {
  const { orgId } = Route.useParams();
  const { access } = useSuspenseQuery(organizationShellQuery(orgId)).data;
  const filters = parseAuditSearch(Route.useSearch());
  const navigate = Route.useNavigate();
  return (
    <div className="flex flex-col gap-6">
      <Heading>Audit log</Heading>
      {access.listOrganizationAuditEvents ? (
        <AuditLog
          filters={filters}
          onFilters={(next) => void navigate({ search: next })}
          target={{ kind: "organization", organizationId: orgId }}
        />
      ) : (
        <Text>Your role or token scopes do not permit reading the audit log (audit:read).</Text>
      )}
    </div>
  );
}
