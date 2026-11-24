import { InboxIcon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { organizationShellQuery } from "../../data/console-queries.ts";
import { emailSetupQuery } from "../../data/agent-email-setup-queries.ts";
import { useInstallCopy } from "../../edition.ts";
import { inboxPagesQuery } from "../../data/agent-email-inbox-queries.ts";
import { INBOX_STATUSES, type InboxStatus } from "../../email/inbox-state.ts";
import { oneOf } from "../../observability/range.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ListEmpty, FilterSelect, LoadMore } from "../list-controls.tsx";
import { Icon } from "../icon.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { SectionBoundary } from "../section-boundary.tsx";
import { CreateInboxDialog } from "./inbox-dialogs.tsx";
import { ReadinessChecklist } from "./readiness-checklist.tsx";
import { StatusBadge } from "@/components/status-badge";

export function EmailSetup({
  onStatus,
  scope,
  status,
}: Readonly<{
  onStatus: (status: InboxStatus | undefined) => void;
  scope: EnvironmentScope;
  status: InboxStatus | undefined;
}>) {
  const { data: setup } = useSuspenseQuery(emailSetupQuery(scope));
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const [creating, setCreating] = useState(false);
  const copy = useInstallCopy();
  const create = shell.access.createAgentEmailInbox ? (
    <Button onClick={() => setCreating(true)}>
      <Icon icon={PlusSignIcon} />
      Create inbox
    </Button>
  ) : undefined;
  if (setup.kind === "not_installed") {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Icon icon={InboxIcon} />
          </EmptyMedia>
          <EmptyTitle>Agent email is not installed on this platform</EmptyTitle>
          <EmptyDescription>{copy.agentEmailNotInstalled}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div className="flex flex-col gap-8">
      <ReadinessChecklist checks={setup.checks} emailPath={`${environmentPath(scope)}/email`} />
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <FilterSelect
            label="Status"
            onChange={(next) => onStatus(oneOf(INBOX_STATUSES, next))}
            options={INBOX_STATUSES.map((value) => ({ label: value, value }))}
            value={status}
          />
          {create ? <div className="ml-auto">{create}</div> : null}
        </div>
        <SectionBoundary resetKey={status ?? "any"}>
          <InboxTable emptyAction={create} scope={scope} status={status} />
        </SectionBoundary>
      </div>
      {shell.access.createAgentEmailInbox ? (
        <CreateInboxDialog onClose={() => setCreating(false)} open={creating} scope={scope} />
      ) : null}
    </div>
  );
}

function InboxTable({
  emptyAction,
  scope,
  status,
}: Readonly<{
  emptyAction: ReactNode;
  scope: EnvironmentScope;
  status: InboxStatus | undefined;
}>) {
  const pagesQuery = inboxPagesQuery(scope, status);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(pagesQuery);
  const inboxes = data.pages.flatMap((page) => page.items);
  const basePath = `${environmentPath(scope)}/email/inboxes`;
  return (
    <div className="flex flex-col gap-4">
      {inboxes.length === 0 && hasNextPage ? null : inboxes.length === 0 && status !== undefined ? (
        <ListEmpty docs="/docs/capabilities/agent-email" icon={InboxIcon} title="No inboxes match">
          Change or clear the filters.
        </ListEmpty>
      ) : inboxes.length === 0 ? (
        <ListEmpty
          action={emptyAction}
          docs="/docs/capabilities/agent-email"
          icon={InboxIcon}
          title="No inboxes"
        >
          An inbox is an address agents send from and receive at.
        </ListEmpty>
      ) : (
        <Table striped>
          <TableHeader>
            <TableRow>
              <TableHead>Address</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>ID</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {inboxes.map((inbox) => (
              <TableRow href={`${basePath}/${inbox.id}`} key={inbox.id} title={inbox.address}>
                <TableCell>
                  {inbox.address}
                  {inbox.name ? (
                    <div className="text-xs/5 text-muted-foreground">{inbox.name}</div>
                  ) : null}
                </TableCell>
                <TableCell>
                  <StatusBadge status={inbox.status} />
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <Timestamp value={inbox.createdAt} />
                </TableCell>
                <TableCell>
                  <PublicId value={inbox.id} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <LoadMore
        error={error}
        fetchNextPage={fetchNextPage}
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        queryKey={pagesQuery.queryKey}
      />
    </div>
  );
}
