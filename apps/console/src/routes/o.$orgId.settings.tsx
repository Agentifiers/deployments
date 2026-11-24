import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { SettingsPage } from "../components/tenancy/settings-page.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import { tenancyResourceQuery } from "../data/tenancy-settings-queries.ts";
import { useInstallCopy } from "../edition.ts";
import { Link } from "@/components/ui/link";
import { Text } from "@/components/ui/text";

export const Route = createFileRoute("/o/$orgId/settings")({
  loader: ({ context, params }) => {
    void context.queryClient.prefetchQuery(
      tenancyResourceQuery({ level: "organization", organizationId: params.orgId }),
    );
  },
  component: OrganizationSettings,
});

function OrganizationSettings() {
  const { orgId } = Route.useParams();
  const {
    data: { access },
  } = useSuspenseQuery(organizationShellQuery(orgId));
  return (
    <SectionBoundary resetKey={orgId}>
      <SettingsPage
        canArchive={false}
        canEdit={access.updateOrganization}
        danger={<EraseOrganization canErase={access.createTenantErasure} organizationId={orgId} />}
        reference={{ level: "organization", organizationId: orgId }}
      />
    </SectionBoundary>
  );
}

/** Organizations have no archive route; erasure on Data governance is how one is removed. */
function EraseOrganization({
  canErase,
  organizationId,
}: Readonly<{ canErase: boolean; organizationId: string }>) {
  const { erasureBillingNote } = useInstallCopy();
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm/6 font-medium">Erase this organization</p>
      <Text>
        Erasure permanently deletes every project, environment, agent, run, thread, file, and
        member, with their search indexes and observability data. Every member loses access and API
        keys stop working. Runs must be stopped first. It cannot be undone.
      </Text>
      {erasureBillingNote ? <Text>{erasureBillingNote}</Text> : null}
      {canErase ? (
        <div>
          <Link
            className="text-sm/6 font-medium text-destructive underline"
            href={`/o/${organizationId}/governance`}
          >
            Go to erasure on Data governance
          </Link>
        </div>
      ) : (
        <Text>Only an organization owner can erase it.</Text>
      )}
    </div>
  );
}
