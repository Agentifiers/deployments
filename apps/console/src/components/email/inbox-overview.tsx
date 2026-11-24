import { Link01Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { organizationShellQuery } from "../../data/console-queries.ts";
import { bindingPagesQuery, inboxQuery } from "../../data/agent-email-inbox-queries.ts";
import type { AgentEmailBinding } from "../../email/inbox-state.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import { Button } from "@/components/ui/button";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { Subheading } from "@/components/ui/heading";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TextLink } from "@/components/ui/text";
import { Icon } from "../icon.tsx";
import { ListEmpty, LoadMore } from "../list-controls.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { SectionBoundary } from "../section-boundary.tsx";
import { ArchiveBindingDialog, CreateBindingDialog } from "./inbox-dialogs.tsx";
import { StatusBadge } from "@/components/status-badge";

export function InboxOverview({
  inboxId,
  scope,
}: Readonly<{ inboxId: string; scope: EnvironmentScope }>) {
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const { data: inbox } = useSuspenseQuery(inboxQuery(scope, inboxId));
  const [binding, setBinding] = useState(false);
  const emailPath = `${environmentPath(scope)}/email`;
  return (
    <div className="flex flex-col gap-10">
      <DescriptionList>
        <DescriptionTerm>Address</DescriptionTerm>
        <DescriptionDetails>{inbox.address}</DescriptionDetails>
        <DescriptionTerm>Domain</DescriptionTerm>
        <DescriptionDetails>
          <TextLink href={`${emailPath}/domains/${inbox.domainId}`}>
            <PublicId value={inbox.domainId} />
          </TextLink>
        </DescriptionDetails>
        <DescriptionTerm>Created</DescriptionTerm>
        <DescriptionDetails>
          <Timestamp value={inbox.createdAt} />
        </DescriptionDetails>
        <DescriptionTerm>Updated</DescriptionTerm>
        <DescriptionDetails>
          <Timestamp value={inbox.updatedAt} />
        </DescriptionDetails>
        <DescriptionTerm>ID</DescriptionTerm>
        <DescriptionDetails>
          <PublicId value={inbox.id} />
        </DescriptionDetails>
      </DescriptionList>
      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Subheading>Bindings</Subheading>
          {shell.access.createAgentEmailBinding && inbox.status !== "archived" ? (
            <Button className="ml-auto" onClick={() => setBinding(true)} variant="outline">
              <Icon icon={PlusSignIcon} />
              Bind
            </Button>
          ) : null}
        </div>
        <SectionBoundary resetKey={inbox.id}>
          <BindingTable inboxId={inbox.id} scope={scope} />
        </SectionBoundary>
      </section>
      {shell.access.createAgentEmailBinding ? (
        <CreateBindingDialog
          inbox={inbox}
          onClose={() => setBinding(false)}
          open={binding}
          scope={scope}
        />
      ) : null}
    </div>
  );
}

export function BindingTarget({
  binding,
  scope,
}: Readonly<{ binding: AgentEmailBinding; scope: EnvironmentScope }>) {
  if (binding.bindingType === "external")
    return <span className="font-mono">{binding.externalId}</span>;
  return (
    <TextLink href={`${environmentPath(scope)}/agents/${binding.externalId}/deployments`}>
      Deployment <PublicId value={binding.agentDeploymentId ?? binding.externalId} />
    </TextLink>
  );
}

function BindingTable({ inboxId, scope }: Readonly<{ inboxId: string; scope: EnvironmentScope }>) {
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const pagesQuery = bindingPagesQuery(scope, inboxId);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(pagesQuery);
  const [archiving, setArchiving] = useState<AgentEmailBinding>();
  const bindings = data.pages.flatMap((page) => page.items);
  const canArchive = shell.access.deleteAgentEmailBinding;
  return (
    <div className="flex flex-col gap-4">
      {bindings.length === 0 && hasNextPage ? null : bindings.length === 0 ? (
        <ListEmpty docs="/docs/capabilities/agent-email" icon={Link01Icon} title="No bindings">
          Bind the inbox to a deployment so that mail it receives starts runs.
        </ListEmpty>
      ) : (
        <Table dense>
          <TableHeader>
            <TableRow>
              <TableHead>Binding</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Routes to</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
              {canArchive ? <TableHead /> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {bindings.map((binding) => (
              <TableRow key={binding.id}>
                <TableCell>
                  <TextLink href={`${environmentPath(scope)}/email/bindings/${binding.id}`}>
                    <PublicId value={binding.id} />
                  </TextLink>
                </TableCell>
                <TableCell>
                  {binding.bindingType === "platform_agent" ? "Agent" : "External"}
                </TableCell>
                <TableCell>
                  <BindingTarget binding={binding} scope={scope} />
                </TableCell>
                <TableCell>
                  <StatusBadge status={binding.status} />
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <Timestamp value={binding.createdAt} />
                </TableCell>
                {canArchive ? (
                  <TableCell className="text-right">
                    {binding.status === "active" ? (
                      <Button onClick={() => setArchiving(binding)} variant="ghost">
                        Archive
                      </Button>
                    ) : null}
                  </TableCell>
                ) : null}
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
      {canArchive ? (
        <ArchiveBindingDialog
          binding={archiving}
          onClose={() => setArchiving(undefined)}
          scope={scope}
        />
      ) : null}
    </div>
  );
}
