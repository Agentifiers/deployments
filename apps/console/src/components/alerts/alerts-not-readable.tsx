import { Notification01Icon } from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import { monitorsRouteQuery } from "../../data/alert-queries.ts";
import { useInstallCopy } from "../../edition.ts";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Text } from "@/components/ui/text";
import { Icon } from "../icon.tsx";

/**
 * Why the Alerts page shows nothing to a caller the console does not let read monitors: the
 * install does not serve the monitors API yet, or the caller's role or token scopes stop them.
 */
export function AlertsNotReadable({ organizationId }: Readonly<{ organizationId: string }>) {
  const { data: route } = useSuspenseQuery(monitorsRouteQuery(organizationId));
  const copy = useInstallCopy();
  if (route === "not_deployed") {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Icon icon={Notification01Icon} />
          </EmptyMedia>
          <EmptyTitle>{copy.alertsNotDeployed.title}</EmptyTitle>
          <EmptyDescription>{copy.alertsNotDeployed.description}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return <Text>Your role or token scopes do not permit reading monitors (monitors:read).</Text>;
}
