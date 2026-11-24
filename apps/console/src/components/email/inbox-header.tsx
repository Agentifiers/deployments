import { Archive02Icon, PauseIcon, PencilEdit02Icon, PlayIcon } from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { organizationShellQuery } from "../../data/console-queries.ts";
import { inboxQuery } from "../../data/agent-email-inbox-queries.ts";
import { INBOX_ACTIONS, inboxTabs, type InboxAction } from "../../email/inbox-state.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import { Button } from "@/components/ui/button";
import { Heading } from "@/components/ui/heading";
import { Text } from "@/components/ui/text";
import { BackLink } from "../back-link.tsx";
import { Icon } from "../icon.tsx";
import { RouteTabs } from "../route-tabs.tsx";
import { InboxStatusDialog, RenameInboxDialog } from "./inbox-dialogs.tsx";
import { StatusBadge } from "@/components/status-badge";

const ACTION_ICONS: Readonly<Record<InboxAction, IconSvgElement>> = {
  archive: Archive02Icon,
  pause: PauseIcon,
  resume: PlayIcon,
};

const ACTION_LABELS: Readonly<Record<InboxAction, string>> = {
  archive: "Archive",
  pause: "Pause",
  resume: "Resume",
};

export function InboxHeader({
  inboxId,
  pathname,
  scope,
}: Readonly<{ inboxId: string; pathname: string; scope: EnvironmentScope }>) {
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const { data: inbox } = useSuspenseQuery(inboxQuery(scope, inboxId));
  const [action, setAction] = useState<InboxAction>();
  const [renaming, setRenaming] = useState(false);
  const canUpdate = shell.access.updateAgentEmailInbox;
  const basePath = `${environmentPath(scope)}/email/inboxes/${inbox.id}`;
  return (
    <div className="flex flex-col gap-6">
      <BackLink href={`${environmentPath(scope)}/email`} label="Inboxes" />
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <Heading level={2}>{inbox.address}</Heading>
          {inbox.name ? <Text>{inbox.name}</Text> : null}
        </div>
        <StatusBadge status={inbox.status} />
        {canUpdate ? (
          <div className="ml-auto flex flex-wrap gap-3">
            <Button onClick={() => setRenaming(true)} variant="outline">
              <Icon icon={PencilEdit02Icon} />
              Rename
            </Button>
            {INBOX_ACTIONS[inbox.status].map((next) => (
              <Button
                key={next}
                onClick={() => setAction(next)}
                variant={next === "archive" ? "destructive" : "outline"}
              >
                <Icon icon={ACTION_ICONS[next]} />
                {ACTION_LABELS[next]}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
      <RouteTabs label="Inbox sections" tabs={inboxTabs(basePath, pathname)} />
      {canUpdate ? (
        <>
          <RenameInboxDialog
            inbox={inbox}
            onClose={() => setRenaming(false)}
            open={renaming}
            scope={scope}
          />
          <InboxStatusDialog
            action={action}
            inbox={inbox}
            onClose={() => setAction(undefined)}
            scope={scope}
          />
        </>
      ) : null}
    </div>
  );
}
