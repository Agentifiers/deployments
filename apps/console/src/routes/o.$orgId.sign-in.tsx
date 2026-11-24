import type { PlanFeature } from "@deployments-ai/api-contract";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { DirectoryPanel } from "../components/sign-in/directory-panel.tsx";
import { IdentityProviderPanel } from "../components/sign-in/identity-provider-panel.tsx";
import { LoginDomains } from "../components/sign-in/login-domains.tsx";
import { ProviderLinks } from "../components/sign-in/provider-links.tsx";
import { directoryQuery } from "../data/directory-sync-queries.ts";
import { organizationShellQuery } from "../data/console-queries.ts";
import { organizationStandingQuery } from "../data/organization-account-queries.ts";
import {
  identityProviderLinksQuery,
  identityProviderQuery,
  loginDomainsQuery,
} from "../data/sign-in-queries.ts";
import { useInstallCopy } from "../edition.ts";
import { planAccess } from "../sign-in/plan-features.ts";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import { Heading } from "@/components/ui/heading";
import { Skeleton } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";

const FEATURE_TITLES: Readonly<Record<PlanFeature, string>> = {
  scim: "Directory sync is not included in your plan",
  sso: "Single sign-on is not included in your plan",
};

export const Route = createFileRoute("/o/$orgId/sign-in")({
  loader: async ({ context, params }) => {
    const { access } = await context.queryClient.ensureQueryData(
      organizationShellQuery(params.orgId),
    );
    if (access.getOrganizationStanding) {
      void context.queryClient.prefetchQuery(organizationStandingQuery(params.orgId));
    }
    if (access.listLoginDomains) {
      void context.queryClient.prefetchQuery(loginDomainsQuery(params.orgId));
    }
    if (access.getIdentityProvider) {
      void context.queryClient.prefetchQuery(identityProviderQuery(params.orgId));
    }
    if (access.listIdentityProviderLinks) {
      void context.queryClient.prefetchInfiniteQuery(identityProviderLinksQuery(params.orgId));
    }
    if (access.getDirectory) {
      void context.queryClient.prefetchQuery(directoryQuery(params.orgId));
    }
  },
  component: SignIn,
});

function PlanNotice({ feature }: Readonly<{ feature: PlanFeature }>) {
  const copy = useInstallCopy();
  return (
    <Callout>
      <CalloutTitle>{FEATURE_TITLES[feature]}</CalloutTitle>
      <CalloutDescription>
        You can review and remove the current setup. {copy.featureNotInPlan}
      </CalloutDescription>
    </Callout>
  );
}

function SignIn() {
  const { orgId } = Route.useParams();
  const {
    data: { access: roleAccess, authorization },
  } = useSuspenseQuery(organizationShellQuery(orgId));
  // A failed standing read leaves the panels as the role allows; the API still enforces the plan.
  const { data: standing } = useQuery({
    ...organizationStandingQuery(orgId),
    enabled: roleAccess.getOrganizationStanding,
  });
  const features = standing?.effective.features ?? { scim: true, sso: true };
  const access = planAccess(roleAccess, features);
  return (
    <div className="flex flex-col gap-10">
      <Heading>Sign-in</Heading>
      {access.getIdentityProvider ? (
        <>
          {features.sso ? null : <PlanNotice feature="sso" />}
          <SectionBoundary fallback={<Skeleton className="h-48 rounded-lg" />} resetKey={orgId}>
            <IdentityProviderPanel
              access={access}
              authorization={authorization}
              organizationId={orgId}
            />
          </SectionBoundary>
        </>
      ) : (
        <Text>
          Your role or token scopes do not permit managing sign-in (owner or admin, members:read).
        </Text>
      )}
      {access.listLoginDomains ? (
        <SectionBoundary fallback={<Skeleton className="h-32 rounded-lg" />} resetKey={orgId}>
          <LoginDomains access={access} organizationId={orgId} />
        </SectionBoundary>
      ) : null}
      {access.listIdentityProviderLinks ? (
        <SectionBoundary fallback={<Skeleton className="h-32 rounded-lg" />} resetKey={orgId}>
          <ProviderLinks canDelete={access.deleteIdentityProviderLink} organizationId={orgId} />
        </SectionBoundary>
      ) : null}
      {access.getDirectory ? (
        <>
          {features.scim ? null : <PlanNotice feature="scim" />}
          <SectionBoundary fallback={<Skeleton className="h-32 rounded-lg" />} resetKey={orgId}>
            <DirectoryPanel access={access} organizationId={orgId} />
          </SectionBoundary>
        </>
      ) : null}
    </div>
  );
}
