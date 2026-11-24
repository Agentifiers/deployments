import { PUBLIC_ID_PATTERN } from "@deployments-ai/api-contract/primitives";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { Heading, Subheading } from "@/components/ui/heading";
import { Skeleton } from "@/components/ui/skeleton";
import { Code, Text, TextLink } from "@/components/ui/text";
import { BackLink } from "../components/back-link.tsx";
import { PublicId } from "../components/public-id.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { accessIsOpen, OperatorAccessPanel } from "../components/system/operator-access.tsx";
import { OrganizationMembers } from "../components/system/organization-members.tsx";
import {
  MonthPicker,
  OrganizationSpend,
  spendMonth,
} from "../components/system/organization-spend.tsx";
import {
  OrganizationStanding,
  StandingHistory,
} from "../components/system/organization-standing.tsx";
import { memberDirectoryQuery } from "../data/membership-queries.ts";
import {
  systemOrganizationQuery,
  systemSpendQuery,
  systemStandingHistoryQuery,
  systemStandingQuery,
} from "../data/system-queries.ts";
import { useConsoleEdition } from "../edition.ts";
import { StatusBadge } from "@/components/status-badge";

// Option order matters: `loader` infers `deps` only when `validateSearch` and `loaderDeps` precede it.
export const Route = createFileRoute("/system/organizations/$organizationId")({
  validateSearch: (search): { readonly month?: string } =>
    typeof search["month"] === "string" ? { month: search["month"] } : {},
  loaderDeps: ({ search }) => ({ month: spendMonth(search.month) }),
  beforeLoad: ({ params }) => {
    if (!PUBLIC_ID_PATTERN.test(params.organizationId)) throw notFound();
  },
  loader: async ({ context, deps, params }) => {
    if (!context.platformAdministrator) return;
    const { organizationId } = params;
    void context.queryClient.prefetchQuery(systemStandingQuery(organizationId));
    void context.queryClient.prefetchInfiniteQuery(systemStandingHistoryQuery(organizationId));
    void context.queryClient.prefetchQuery(systemSpendQuery(organizationId, deps.month));
    const { access } = await context.queryClient.ensureQueryData(
      systemOrganizationQuery(organizationId),
    );
    if (accessIsOpen(access)) {
      void context.queryClient.prefetchQuery(memberDirectoryQuery(organizationId));
    }
  },
  component: SystemOrganization,
});

function SystemOrganization() {
  const { organizationId } = Route.useParams();
  const month = spendMonth(Route.useSearch().month);
  const navigate = Route.useNavigate();
  const { data } = useSuspenseQuery(systemOrganizationQuery(organizationId));
  const { organization } = data;
  const open = accessIsOpen(data.access);
  const panels = useConsoleEdition().systemOrganizationPanels ?? [];
  return (
    <div className="flex flex-col gap-10">
      <div className="space-y-2">
        <BackLink href="/system/organizations" label="Organizations" />
        <div className="flex flex-wrap items-center gap-3">
          <Heading>{organization.name}</Heading>
          <StatusBadge status={organization.status} />
        </div>
        <Text>
          <Code>{organization.slug}</Code> · <PublicId full value={organization.id} /> ·{" "}
          {open ? (
            <TextLink href={`/o/${organization.id}`}>Open the organization</TextLink>
          ) : (
            <span className="text-muted-foreground">
              Open access below to open the organization
            </span>
          )}
        </Text>
      </div>
      <OperatorAccessPanel access={data.access} organization={organization} />
      <SectionBoundary
        fallback={<Skeleton className="h-64 rounded-lg" />}
        resetKey={organizationId}
      >
        <OrganizationStanding organizationId={organizationId} slug={organization.slug} />
      </SectionBoundary>
      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <Subheading>Spend</Subheading>
          <div className="ml-auto">
            <MonthPicker
              month={month}
              onMonth={(next) => void navigate({ replace: true, search: { month: next } })}
            />
          </div>
        </div>
        <SectionBoundary
          fallback={<Skeleton className="h-28 rounded-lg" />}
          resetKey={`${organizationId}-${month}`}
        >
          <OrganizationSpend month={month} organizationId={organizationId} />
        </SectionBoundary>
      </section>
      <section className="flex flex-col gap-4">
        <Subheading>Members</Subheading>
        {open ? (
          <SectionBoundary
            fallback={<Skeleton className="h-32 rounded-lg" />}
            resetKey={organizationId}
          >
            <OrganizationMembers organizationId={organizationId} />
          </SectionBoundary>
        ) : (
          <Text>Members are the organization's data; open operator access to see them.</Text>
        )}
      </section>
      <section className="flex flex-col gap-4">
        <Subheading>Standing history</Subheading>
        <SectionBoundary
          fallback={<Skeleton className="h-40 rounded-lg" />}
          resetKey={organizationId}
        >
          <StandingHistory organizationId={organizationId} />
        </SectionBoundary>
      </section>
      {panels.map((Panel, index) => (
        <Panel key={index} organizationId={organizationId} />
      ))}
    </div>
  );
}
