import { PUBLIC_ID_PATTERN } from "@deployments-ai/api-contract/primitives";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, notFound, Outlet, useParams } from "@tanstack/react-router";
import { OrganizationShellLayout } from "../components/organization-shell.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import { organizationStandingQuery } from "../data/organization-account-queries.ts";
import { organizationPageTitle } from "../page-title.ts";

export const Route = createFileRoute("/o/$orgId")({
  // `beforeLoad` runs before any child loader, so a malformed ID never reaches a server function.
  beforeLoad: ({ params }) => {
    if (!PUBLIC_ID_PATTERN.test(params.orgId)) throw notFound();
  },
  component: OrganizationLayout,
  // Titles every organization and environment page from the open page's sidebar item; the
  // deepest route's title wins, so a page can still set its own.
  head: ({ loaderData, match, matches }) =>
    loaderData
      ? {
          meta: [
            {
              title: organizationPageTitle({
                edition: match.context.edition,
                // With no child match (a Not found URL) the layout's own path would read as Overview.
                pathname:
                  matches.at(-1)?.routeId === match.routeId ? "" : (matches.at(-1)?.pathname ?? ""),
                shell: loaderData,
              }),
            },
          ],
        }
      : {},
  loader: async ({ context, params }) => {
    const shell = await context.queryClient.ensureQueryData(organizationShellQuery(params.orgId));
    // Awaited so the banner renders on the server; prefetchQuery never throws.
    if (shell.access.getOrganizationStanding) {
      await context.queryClient.prefetchQuery(organizationStandingQuery(params.orgId));
    }
    return shell;
  },
});

function OrganizationLayout() {
  const { orgId } = Route.useParams();
  const { envId } = useParams({ strict: false });
  const { data: shell } = useSuspenseQuery(organizationShellQuery(orgId));
  return (
    <OrganizationShellLayout environmentId={envId} shell={shell}>
      <Outlet />
    </OrganizationShellLayout>
  );
}
