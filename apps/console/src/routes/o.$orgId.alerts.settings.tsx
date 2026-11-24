import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { AlertSettings } from "../components/alerts/alert-settings.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { alertPreferencesQuery, monitorPagesQuery } from "../data/alert-queries.ts";
import { organizationShellQuery } from "../data/console-queries.ts";
import { Text } from "@/components/ui/text";

export const Route = createFileRoute("/o/$orgId/alerts/settings")({
  loader: async ({ context, params }) => {
    const { access } = await context.queryClient.ensureQueryData(
      organizationShellQuery(params.orgId),
    );
    if (access.getAlertNotificationPreferences) {
      void context.queryClient.prefetchQuery(alertPreferencesQuery(params.orgId));
      void context.queryClient.prefetchInfiniteQuery(
        monitorPagesQuery({ organizationId: params.orgId }),
      );
    }
  },
  component: AlertEmailSettings,
});

function AlertEmailSettings() {
  const { orgId } = Route.useParams();
  const { access } = useSuspenseQuery(organizationShellQuery(orgId)).data;
  return access.getAlertNotificationPreferences ? (
    <SectionBoundary resetKey={orgId}>
      <AlertSettings organizationId={orgId} />
    </SectionBoundary>
  ) : (
    <Text>Only a signed-in member has alert email settings.</Text>
  );
}
