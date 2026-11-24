import { useSuspenseQuery } from "@tanstack/react-query";
import { ClientOnly, createFileRoute } from "@tanstack/react-router";
import { SectionBoundary } from "../components/section-boundary.tsx";
import {
  EnvironmentSpendSection,
  ProjectSpendSection,
} from "../components/tenancy/organization-spend-breakdown.tsx";
import {
  OrganizationLimitsSection,
  OrganizationSpendSection,
} from "../components/tenancy/organization-usage.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import {
  organizationLimitsQuery,
  organizationSpendQuery,
  projectSpendQuery,
} from "../data/organization-account-queries.ts";
import { useInstallCopy } from "../edition.ts";
import {
  parseSpendMonthSearch,
  spendMonthLabel,
  spendMonthOf,
  spendMonths,
  type SpendMonthSearch,
} from "../usage/organization-spend.ts";
import { Field, Label } from "@/components/ui/field";
import { Heading, Subheading } from "@/components/ui/heading";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";

// Option order matters: `loader` infers `deps` only when `validateSearch` and `loaderDeps` precede it.
export const Route = createFileRoute("/o/$orgId/usage")({
  validateSearch: (search): SpendMonthSearch => parseSpendMonthSearch(search, new Date()),
  loaderDeps: ({ search }) => search,
  loader: async ({ context, deps, params }) => {
    const { access } = await context.queryClient.ensureQueryData(
      organizationShellQuery(params.orgId),
    );
    if (access.getOrganizationSpend) {
      void context.queryClient.prefetchQuery(organizationSpendQuery(params.orgId, deps.month));
    }
    if (access.getOrganizationProjectSpend) {
      void context.queryClient.prefetchQuery(
        projectSpendQuery(params.orgId, deps.month ?? spendMonthOf(new Date())),
      );
    }
    if (access.getOrganizationLimits) {
      void context.queryClient.prefetchQuery(organizationLimitsQuery(params.orgId));
    }
  },
  component: Usage,
});

function Usage() {
  const { orgId } = Route.useParams();
  const { month } = Route.useSearch();
  const navigate = Route.useNavigate();
  const {
    data: { access, projects },
  } = useSuspenseQuery(organizationShellQuery(orgId));
  const copy = useInstallCopy();
  const months = spendMonths(new Date());
  const shown = month ?? months[0]!;
  const sectionKey = `${orgId}/${shown}`;
  return (
    <div className="flex flex-col gap-10">
      <Heading>Usage and limits</Heading>
      {access.getOrganizationSpend ? (
        <section className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-4">
            <Subheading>Spend</Subheading>
            <Field className="ml-auto w-56">
              <Label>Month</Label>
              <NativeSelect
                onChange={(event) => {
                  const next = event.target.value;
                  void navigate({ search: next === months[0] ? {} : { month: next } });
                }}
                value={shown}
              >
                {months.map((option) => (
                  <option key={option} value={option}>
                    {spendMonthLabel(option)}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <SectionBoundary
            fallback={<Skeleton className="h-28 rounded-lg" />}
            resetKey={sectionKey}
          >
            <OrganizationSpendSection copy={copy} month={month} organizationId={orgId} />
          </SectionBoundary>
        </section>
      ) : null}
      {access.getOrganizationProjectSpend ? (
        <section className="flex flex-col gap-4">
          <Subheading>By project</Subheading>
          <SectionBoundary
            fallback={<Skeleton className="h-32 rounded-lg" />}
            resetKey={sectionKey}
          >
            <ProjectSpendSection
              copy={copy}
              month={shown}
              organizationId={orgId}
              projects={projects}
            />
          </SectionBoundary>
        </section>
      ) : null}
      {(access.getWorkspaceSpend && access.listWorkspaces) || access.listCostRecords ? (
        <section className="flex flex-col gap-4">
          <Subheading>By environment</Subheading>
          {/* One spend read per workspace can outlast a server render, so it loads in the browser. */}
          <ClientOnly fallback={<Skeleton className="h-40 rounded-lg" />}>
            <EnvironmentSpendSection
              copy={copy}
              month={shown}
              organizationId={orgId}
              projects={projects}
              showCosts={access.listCostRecords}
              showWorkspaces={access.getWorkspaceSpend && access.listWorkspaces}
            />
          </ClientOnly>
        </section>
      ) : null}
      {access.getOrganizationLimits ? (
        <section className="flex flex-col gap-4">
          <Subheading>Limits</Subheading>
          <SectionBoundary fallback={<Skeleton className="h-40 rounded-lg" />} resetKey={orgId}>
            <OrganizationLimitsSection organizationId={orgId} />
          </SectionBoundary>
        </section>
      ) : null}
    </div>
  );
}
