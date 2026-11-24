import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { EgressAllowlistSection } from "../components/governance/egress-allowlist-section.tsx";
import { EndUserErasureSection } from "../components/governance/end-user-erasure.tsx";
import { ErasureSection } from "../components/governance/erasure-section.tsx";
import { ExportActions } from "../components/governance/export-actions.tsx";
import { OperationHistory } from "../components/governance/operation-history.tsx";
import { RetentionSection } from "../components/governance/retention-section.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import { organizationStandingQuery } from "../data/organization-account-queries.ts";
import {
  egressAllowlistQuery,
  organizationErasureQuery,
  operationPagesQuery,
  retentionPolicyQuery,
} from "../data/governance-queries.ts";
import { EXPORT_KINDS } from "../governance/operation-state.ts";
import { Heading, Subheading } from "@/components/ui/heading";
import { Skeleton } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";

const EXPORT_OPERATIONS = {
  "audit-export": "createImmutableAuditExport",
  "tenant-export": "createTenantDataExport",
} as const;

export const Route = createFileRoute("/o/$orgId/governance/")({
  loader: async ({ context, params }) => {
    const { access } = await context.queryClient.ensureQueryData(
      organizationShellQuery(params.orgId),
    );
    if (access.getOrganizationRetentionPolicy) {
      void context.queryClient.prefetchQuery(retentionPolicyQuery(params.orgId));
    }
    if (access.getOrganizationEgressAllowlist) {
      void context.queryClient.prefetchQuery(egressAllowlistQuery(params.orgId));
    }
    if (access.listGovernanceOperations) {
      void context.queryClient.prefetchInfiniteQuery(operationPagesQuery(params.orgId));
    }
    if (access.createTenantErasure) {
      void context.queryClient.prefetchQuery(organizationErasureQuery(params.orgId));
    }
  },
  component: DataGovernance,
});

function DataGovernance() {
  const { orgId } = Route.useParams();
  const {
    data: { access, organization },
  } = useSuspenseQuery(organizationShellQuery(orgId));
  const exportKinds = EXPORT_KINDS.filter((kind) => access[EXPORT_OPERATIONS[kind]]);
  const { data: standing } = useQuery({
    ...organizationStandingQuery(orgId),
    enabled: access.getOrganizationStanding,
  });
  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-wrap items-center gap-3">
        <Heading>Data governance</Heading>
        <div className="ml-auto flex flex-wrap gap-3">
          <ExportActions kinds={exportKinds} organizationId={orgId} />
        </div>
      </div>
      {access.getOrganizationRetentionPolicy ? (
        <SectionBoundary fallback={<Skeleton className="h-64 rounded-lg" />} resetKey={orgId}>
          <RetentionSection
            canEdit={access.updateOrganizationRetentionPolicy}
            organizationId={orgId}
            organizationSlug={organization.slug}
          />
        </SectionBoundary>
      ) : (
        <Text>Your role or token scopes do not permit reading retention (governance:read).</Text>
      )}
      {standing?.dataBoundary && access.getOrganizationEgressAllowlist ? (
        <SectionBoundary fallback={<Skeleton className="h-48 rounded-lg" />} resetKey={orgId}>
          <EgressAllowlistSection
            canEdit={access.replaceOrganizationEgressAllowlist}
            organizationId={orgId}
          />
        </SectionBoundary>
      ) : null}
      {access.listGovernanceOperations ? (
        <section className="flex flex-col gap-4">
          <Subheading>History</Subheading>
          <SectionBoundary fallback={<Skeleton className="h-32 rounded-lg" />} resetKey={orgId}>
            <OperationHistory organizationId={orgId} />
          </SectionBoundary>
        </section>
      ) : null}
      {access.eraseEndUser ? (
        <SectionBoundary fallback={<Skeleton className="h-32 rounded-lg" />} resetKey={orgId}>
          <EndUserErasureSection organizationId={orgId} />
        </SectionBoundary>
      ) : null}
      {access.createTenantErasure ? (
        <SectionBoundary fallback={<Skeleton className="h-48 rounded-lg" />} resetKey={orgId}>
          <ErasureSection organizationId={orgId} />
        </SectionBoundary>
      ) : null}
    </div>
  );
}
