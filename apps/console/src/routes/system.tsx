import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet } from "@tanstack/react-router";
import { SystemShell } from "../components/system/system-shell.tsx";
import { platformAdministratorQuery } from "../data/console-queries.ts";
import { useInstallCopy } from "../edition.ts";
import { systemPageTitle } from "../page-title.ts";

export const Route = createFileRoute("/system")({
  // Child loaders read `platformAdministrator`, so a refused caller never fans out system reads.
  beforeLoad: async ({ context }) => ({
    platformAdministrator: await context.queryClient.ensureQueryData(platformAdministratorQuery()),
  }),
  component: SystemLayout,
  head: ({ match, matches }) => ({
    meta: [
      {
        title: systemPageTitle({
          edition: match.context.edition,
          pathname: matches.at(-1)?.pathname ?? match.pathname,
        }),
      },
    ],
  }),
});

function SystemLayout() {
  const { data: platformAdministrator } = useSuspenseQuery(platformAdministratorQuery());
  return (
    <SystemShell copy={useInstallCopy()} platformAdministrator={platformAdministrator}>
      <Outlet />
    </SystemShell>
  );
}
