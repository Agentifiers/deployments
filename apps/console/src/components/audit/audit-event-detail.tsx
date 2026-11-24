import { useSuspenseQuery } from "@tanstack/react-query";
import { auditEventQuery } from "../../data/audit-queries.ts";
import type { EnvironmentScope } from "../../scope.ts";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { Heading } from "@/components/ui/heading";
import { Code } from "@/components/ui/text";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { AuditActor, RecordedChange } from "./audit-log.tsx";

export function AuditEventDetail({
  eventId,
  scope,
}: Readonly<{ eventId: string; scope: EnvironmentScope }>) {
  const { data: event } = useSuspenseQuery(auditEventQuery(scope, eventId));
  return (
    <div className="flex flex-col gap-8">
      <Heading>
        <Code>{event.action}</Code>
      </Heading>
      <DescriptionList>
        <DescriptionTerm>Time</DescriptionTerm>
        <DescriptionDetails>
          <Timestamp value={event.occurredAt} />
        </DescriptionDetails>
        <DescriptionTerm>Actor</DescriptionTerm>
        <DescriptionDetails>
          <AuditActor actor={event.actor} />
        </DescriptionDetails>
        <DescriptionTerm>Resource</DescriptionTerm>
        <DescriptionDetails>
          {event.resourceType ?? "Not recorded"}{" "}
          {event.resourceId ? <PublicId value={event.resourceId} /> : null}
        </DescriptionDetails>
        <DescriptionTerm>Recorded change</DescriptionTerm>
        <DescriptionDetails>
          <RecordedChange changes={event.changes} />
        </DescriptionDetails>
        <DescriptionTerm>Event ID</DescriptionTerm>
        <DescriptionDetails>
          <PublicId value={event.id} />
        </DescriptionDetails>
      </DescriptionList>
    </div>
  );
}
