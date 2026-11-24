import { ArrowLeft01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { Icon } from "../components/icon.tsx";
import { PublicId } from "../components/public-id.tsx";
import { RouteTabs, type RouteTab } from "../components/route-tabs.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { KIND_LABELS } from "../brains/model.ts";
import { brainViewQuery } from "../data/brain-queries.ts";
import { organizationShellQuery } from "../data/console-queries.ts";
import { environmentPath, type EnvironmentScope } from "../scope.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import { Link } from "@/components/ui/link";
import { Code, Text } from "@/components/ui/text";
import { StatusBadge } from "@/components/status-badge";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/brains/$brainId")({
  loader: ({ context, params }) =>
    void context.queryClient.prefetchQuery(brainViewQuery(params.orgId, params.brainId)),
  component: BrainRoute,
});

function BrainRoute() {
  const { brainId } = Route.useParams();
  return (
    <SectionBoundary resetKey={brainId}>
      <BrainLayout />
    </SectionBoundary>
  );
}

function BrainLayout() {
  const { brainId, envId, orgId, projectId } = Route.useParams();
  const scope: EnvironmentScope = { environmentId: envId, organizationId: orgId, projectId };
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { brain, standing } = useSuspenseQuery(brainViewQuery(orgId, brainId)).data;
  const { access } = useSuspenseQuery(organizationShellQuery(orgId)).data;
  const brainsPath = `${environmentPath(scope)}/brains`;
  const basePath = `${brainsPath}/${brainId}`;
  const tab = (segment: string, label: string): RouteTab => {
    const href = segment ? `${basePath}/${segment}` : basePath;
    return {
      current: segment ? pathname === href || pathname.startsWith(`${href}/`) : pathname === href,
      href,
      label,
    };
  };
  const owner = standing.kind === "owner";
  const tabs = [
    tab("", "Sources"),
    tab("documents", "Documents"),
    tab("review", "Review"),
    ...(owner ? [tab("access", "Access"), tab("settings", "Settings")] : []),
  ];
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <Link
          className="inline-flex w-fit items-center gap-1 text-sm/6 text-muted-foreground hover:text-foreground"
          href={brainsPath}
        >
          <Icon className="size-4" icon={ArrowLeft01Icon} />
          Brains
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <Heading>{brain.name}</Heading>
          <Badge color="zinc">{KIND_LABELS[brain.kind]}</Badge>
          <StatusBadge status={brain.status} />
          {access.searchBrains ? (
            <Button
              className="ml-auto"
              href={`${brainsPath}/search?brainId=${encodeURIComponent(brainId)}`}
              variant="outline"
            >
              <Icon icon={Search01Icon} />
              Search this Brain
            </Button>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <Code>{brain.slug}</Code>
          <PublicId value={brain.id} />
          <Text>Sensitivity {brain.sensitivity}</Text>
        </div>
        {owner ? null : (
          <Text>
            You read this Brain through a grant. Uploading, document changes, and review need a
            writer, curator, or owner grant; access and settings need an owner grant.
          </Text>
        )}
      </div>
      <RouteTabs label="Brain sections" tabs={tabs} />
      <Outlet />
    </div>
  );
}
