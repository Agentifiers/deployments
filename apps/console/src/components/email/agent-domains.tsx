import { Globe02Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { useQueryClient, useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { environmentQuery, organizationShellQuery } from "../../data/console-queries.ts";
import {
  createDomainFn,
  refreshDomainFn,
  revokeDomainFn,
} from "../../data/agent-email-setup-mutations.ts";
import {
  domainPagesQuery,
  domainQuery,
  invalidateAgentEmail,
} from "../../data/agent-email-setup-queries.ts";
import { useInstallCopy } from "../../edition.ts";
import { DOMAIN_NAME } from "../../email/addresses.ts";
import { canRevokeDomain } from "../../email/setup-state.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import { Button } from "@/components/ui/button";
import { DescriptionDetails, DescriptionTerm } from "@/components/ui/description-list";
import { Description, Field, Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ActionDialog, typedConfirmation } from "../action-dialog.tsx";
import { Icon } from "../icon.tsx";
import { ListEmpty, LoadMore } from "../list-controls.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { SectionBoundary } from "../section-boundary.tsx";
import { DomainDetailView } from "./domain-views.tsx";
import { StatusBadge } from "@/components/status-badge";

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function AgentDomains({ scope }: Readonly<{ scope: EnvironmentScope }>) {
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const [creating, setCreating] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      {shell.access.createAgentEmailDomain ? (
        <div className="flex">
          <Button className="ml-auto" onClick={() => setCreating(true)}>
            <Icon icon={PlusSignIcon} />
            Add custom domain
          </Button>
        </div>
      ) : null}
      <SectionBoundary resetKey={scope.environmentId}>
        <DomainTable scope={scope} />
      </SectionBoundary>
      {shell.access.createAgentEmailDomain ? (
        <CreateDomainDialog onClose={() => setCreating(false)} open={creating} scope={scope} />
      ) : null}
    </div>
  );
}

function DomainTable({ scope }: Readonly<{ scope: EnvironmentScope }>) {
  const pagesQuery = domainPagesQuery(scope);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(pagesQuery);
  const domains = data.pages.flatMap((page) => page.items);
  const copy = useInstallCopy();
  const basePath = `${environmentPath(scope)}/email/domains`;
  return (
    <div className="flex flex-col gap-4">
      {domains.length === 0 ? (
        <ListEmpty docs="/docs/capabilities/agent-email" icon={Globe02Icon} title="No domains">
          {capitalized(copy.hostedEmailDomain)} appears here after the first inbox is created.
        </ListEmpty>
      ) : (
        <Table striped>
          <TableHeader>
            <TableRow>
              <TableHead>Domain</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Last checked</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {domains.map((domain) => (
              <TableRow href={`${basePath}/${domain.id}`} key={domain.id} title={domain.domain}>
                <TableCell>{domain.domain}</TableCell>
                <TableCell>
                  <StatusBadge status={domain.status} />
                </TableCell>
                <TableCell>{domain.providerManaged ? "Hosted" : "Custom"}</TableCell>
                <TableCell className="whitespace-nowrap">
                  {domain.lastCheckedAt ? <Timestamp value={domain.lastCheckedAt} /> : "Never"}
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

function CreateDomainDialog({
  onClose,
  open,
  scope,
}: Readonly<{ onClose: () => void; open: boolean; scope: EnvironmentScope }>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const [domain, setDomain] = useState("");
  const { managesEmailSending } = useInstallCopy();
  useEffect(() => {
    if (open) setDomain("");
  }, [open]);
  const value = domain.trim().toLowerCase();
  const valid = DOMAIN_NAME.test(value);
  return (
    <ActionDialog
      confirmLabel="Add domain"
      confirmation={typedConfirmation(environment.type, { phrase: value || "create" })}
      description={`You publish an ownership TXT record, then refresh. The first refresh sets the domain up for sending${managesEmailSending ? ", which needs an active default placement," : ""} and lists the DKIM, MX, and MAIL FROM records to publish next.`}
      invalid={!valid}
      onClose={onClose}
      onSuccess={() => void invalidateAgentEmail(queryClient, scope)}
      open={open}
      run={(idempotencyKey) =>
        createDomainFn({ data: { body: { domain: value }, idempotencyKey, scope } })
      }
      successMessage={(created) => `Added ${created.domain}`}
      title="Add custom domain"
    >
      <Field>
        <Label>Domain</Label>
        <Description>A domain or subdomain whose DNS you control.</Description>
        <Input
          autoComplete="off"
          aria-invalid={domain !== "" && !valid}
          onChange={(event) => setDomain(event.target.value)}
          placeholder="mail.example.com"
          value={domain}
        />
      </Field>
    </ActionDialog>
  );
}

export function AgentDomainDetail({
  domainId,
  scope,
}: Readonly<{ domainId: string; scope: EnvironmentScope }>) {
  const queryClient = useQueryClient();
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const { data: domain } = useSuspenseQuery(domainQuery(scope, domainId));
  const copy = useInstallCopy();
  return (
    <DomainDetailView
      canRefresh={shell.access.refreshAgentEmailDomain}
      back={{ href: `${environmentPath(scope)}/email/domains`, label: "Domains" }}
      canRevoke={shell.access.revokeAgentEmailDomain && canRevokeDomain(domain)}
      domain={domain}
      facts={
        <>
          <DescriptionTerm>Kind</DescriptionTerm>
          <DescriptionDetails>
            {domain.providerManaged ? copy.hostedEmailDomainKind : "Custom"}
          </DescriptionDetails>
        </>
      }
      invalidate={() => invalidateAgentEmail(queryClient, scope)}
      refresh={(idempotencyKey) => refreshDomainFn({ data: { domainId, idempotencyKey, scope } })}
      revoke={(idempotencyKey) => revokeDomainFn({ data: { domainId, idempotencyKey, scope } })}
      scope={scope}
    />
  );
}
