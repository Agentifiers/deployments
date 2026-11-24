import { Archive02Icon } from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { organizationShellQuery } from "../../data/console-queries.ts";
import { bindingQuery } from "../../data/agent-email-inbox-queries.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import { Button } from "@/components/ui/button";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { Heading } from "@/components/ui/heading";
import { TextLink } from "@/components/ui/text";
import { BackLink } from "../back-link.tsx";
import { Icon } from "../icon.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { ArchiveBindingDialog } from "./inbox-dialogs.tsx";
import { BindingTarget } from "./inbox-overview.tsx";
import { StatusBadge } from "@/components/status-badge";

export function BindingDetail({
  bindingId,
  scope,
}: Readonly<{ bindingId: string; scope: EnvironmentScope }>) {
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const { data: binding } = useSuspenseQuery(bindingQuery(scope, bindingId));
  const [archiving, setArchiving] = useState(false);
  const canArchive = shell.access.deleteAgentEmailBinding && binding.status === "active";
  return (
    <div className="flex flex-col gap-8">
      <BackLink href={`${environmentPath(scope)}/email/inboxes/${binding.inboxId}`} label="Inbox" />
      <div className="flex flex-wrap items-center gap-3">
        <Heading level={2}>Binding …{binding.id.slice(-8)}</Heading>
        <StatusBadge status={binding.status} />
        {canArchive ? (
          <Button className="ml-auto" variant="destructive" onClick={() => setArchiving(true)}>
            <Icon icon={Archive02Icon} />
            Archive
          </Button>
        ) : null}
      </div>
      <DescriptionList>
        <DescriptionTerm>Inbox</DescriptionTerm>
        <DescriptionDetails>
          <TextLink href={`${environmentPath(scope)}/email/inboxes/${binding.inboxId}`}>
            <PublicId value={binding.inboxId} />
          </TextLink>
        </DescriptionDetails>
        <DescriptionTerm>Type</DescriptionTerm>
        <DescriptionDetails>
          {binding.bindingType === "platform_agent" ? "Agent deployment" : "External system"}
        </DescriptionDetails>
        <DescriptionTerm>Routes to</DescriptionTerm>
        <DescriptionDetails>
          <BindingTarget binding={binding} scope={scope} />
        </DescriptionDetails>
        <DescriptionTerm>Created</DescriptionTerm>
        <DescriptionDetails>
          <Timestamp value={binding.createdAt} />
        </DescriptionDetails>
        <DescriptionTerm>Updated</DescriptionTerm>
        <DescriptionDetails>
          <Timestamp value={binding.updatedAt} />
        </DescriptionDetails>
        <DescriptionTerm>ID</DescriptionTerm>
        <DescriptionDetails>
          <PublicId value={binding.id} />
        </DescriptionDetails>
      </DescriptionList>
      {canArchive ? (
        <ArchiveBindingDialog
          binding={archiving ? binding : undefined}
          onClose={() => setArchiving(false)}
          scope={scope}
        />
      ) : null}
    </div>
  );
}
