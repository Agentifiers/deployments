import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { RouteTabs } from "../components/route-tabs.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import { useInstallCopy } from "../edition.ts";
import { emailTabs } from "../email/email-tabs.ts";
import { environmentPath } from "../scope.ts";
import { Heading } from "@/components/ui/heading";

export const Route = createFileRoute("/o/$orgId/p/$projectId/e/$envId/email")({
  component: EmailLayout,
});

function EmailLayout() {
  const { envId, orgId, projectId } = Route.useParams();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const { data: shell } = useSuspenseQuery(organizationShellQuery(orgId));
  const { managesEmailSending } = useInstallCopy();
  const emailPath = `${environmentPath({ environmentId: envId, organizationId: orgId, projectId })}/email`;
  return (
    <div className="flex flex-col gap-8">
      <Heading>Email</Heading>
      <RouteTabs
        label="Email sections"
        tabs={emailTabs(emailPath, pathname, shell.access, managesEmailSending)}
      />
      <Outlet />
    </div>
  );
}
