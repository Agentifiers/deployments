import {
  Building03Icon,
  Globe02Icon,
  PauseIcon,
  PlayIcon,
  PlusSignIcon,
  SentIcon,
} from "@hugeicons/core-free-icons";
import { useQueryClient, useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { organizationShellQuery } from "../../data/console-queries.ts";
import { refreshTenantDomainFn, revokeTenantDomainFn } from "../../data/email-tenant-mutations.ts";
import {
  invalidateEmailTenants,
  tenantDomainQuery,
  tenantDomainsQuery,
  tenantPagesQuery,
  tenantQuery,
} from "../../data/email-tenant-queries.ts";
import { TENANT_STATUS_CHANGE } from "../../email/tenant-state.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import { Button } from "@/components/ui/button";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { Heading, Subheading } from "@/components/ui/heading";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Text, TextLink } from "@/components/ui/text";
import { Icon } from "../icon.tsx";
import { ListEmpty, LoadMore } from "../list-controls.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { SectionBoundary } from "../section-boundary.tsx";
import { DomainDetailView } from "./domain-views.tsx";
import {
  CreateTenantDialog,
  CreateTenantDomainDialog,
  SendTenantEmailDialog,
  TenantStatusDialog,
} from "./tenant-dialogs.tsx";
import { StatusBadge } from "@/components/status-badge";

export function TenantList({ scope }: Readonly<{ scope: EnvironmentScope }>) {
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const [creating, setCreating] = useState(false);
  const create = shell.access.createEmailTenant ? (
    <Button onClick={() => setCreating(true)}>
      <Icon icon={PlusSignIcon} />
      Create tenant
    </Button>
  ) : undefined;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Text>
          Sending tenants send one-way transactional mail, such as notifications, from their own
          verified domains and settings. They keep no message history, and agent email inboxes do
          not use them.
        </Text>
        {create ? <div className="ml-auto">{create}</div> : null}
      </div>
      <SectionBoundary resetKey={scope.environmentId}>
        <TenantTable emptyAction={create} scope={scope} />
      </SectionBoundary>
      {shell.access.createEmailTenant ? (
        <CreateTenantDialog onClose={() => setCreating(false)} open={creating} scope={scope} />
      ) : null}
    </div>
  );
}

function TenantTable({
  emptyAction,
  scope,
}: Readonly<{ emptyAction: ReactNode; scope: EnvironmentScope }>) {
  const pagesQuery = tenantPagesQuery(scope);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(pagesQuery);
  const tenants = data.pages.flatMap((page) => page.items);
  const basePath = `${environmentPath(scope)}/email/tenants`;
  return (
    <div className="flex flex-col gap-4">
      {tenants.length === 0 ? (
        <ListEmpty
          action={emptyAction}
          docs="/docs/capabilities/email"
          icon={Building03Icon}
          title="No sending tenants"
        />
      ) : (
        <Table striped>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Provider sending</TableHead>
              <TableHead>Region</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tenants.map((tenant) => (
              <TableRow href={`${basePath}/${tenant.id}`} key={tenant.id} title={tenant.name}>
                <TableCell>{tenant.name}</TableCell>
                <TableCell>
                  <StatusBadge status={tenant.status} />
                </TableCell>
                <TableCell>
                  <StatusBadge status={tenant.sendingStatus} />
                </TableCell>
                <TableCell>{tenant.region}</TableCell>
                <TableCell className="whitespace-nowrap">
                  <Timestamp value={tenant.createdAt} />
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

type TenantDialog = "domain" | "send" | "status";

export function TenantDetail({
  scope,
  tenantId,
}: Readonly<{ scope: EnvironmentScope; tenantId: string }>) {
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const { data: tenant } = useSuspenseQuery(tenantQuery(scope, tenantId));
  const { data: domains } = useSuspenseQuery(tenantDomainsQuery(scope, tenantId));
  const [dialog, setDialog] = useState<TenantDialog>();
  const { access } = shell;
  const close = () => setDialog(undefined);
  const domainsPath = `${environmentPath(scope)}/email/tenant-domains`;
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <Heading level={2}>{tenant.name}</Heading>
        <StatusBadge status={tenant.status} />
        <div className="ml-auto flex flex-wrap gap-3">
          {access.sendEmail && tenant.status === "active" ? (
            <Button onClick={() => setDialog("send")} variant="outline">
              <Icon icon={SentIcon} />
              Send email
            </Button>
          ) : null}
          {access.updateEmailTenant ? (
            <Button onClick={() => setDialog("status")} variant="outline">
              <Icon icon={tenant.status === "active" ? PauseIcon : PlayIcon} />
              {TENANT_STATUS_CHANGE[tenant.status].label}
            </Button>
          ) : null}
        </div>
      </div>
      <DescriptionList>
        <DescriptionTerm>Provider sending status</DescriptionTerm>
        <DescriptionDetails>{tenant.sendingStatus}</DescriptionDetails>
        <DescriptionTerm>Region</DescriptionTerm>
        <DescriptionDetails>{tenant.region}</DescriptionDetails>
        <DescriptionTerm>Configuration set</DescriptionTerm>
        <DescriptionDetails className="font-mono">{tenant.configurationSetName}</DescriptionDetails>
        <DescriptionTerm>Provider tenant</DescriptionTerm>
        <DescriptionDetails className="font-mono">{tenant.providerName}</DescriptionDetails>
        <DescriptionTerm>Created</DescriptionTerm>
        <DescriptionDetails>
          <Timestamp value={tenant.createdAt} />
        </DescriptionDetails>
        <DescriptionTerm>ID</DescriptionTerm>
        <DescriptionDetails>
          <PublicId value={tenant.id} />
        </DescriptionDetails>
      </DescriptionList>
      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Subheading>Domains</Subheading>
          {access.createEmailDomain ? (
            <Button className="ml-auto" onClick={() => setDialog("domain")} variant="outline">
              <Icon icon={PlusSignIcon} />
              Add domain
            </Button>
          ) : null}
        </div>
        {domains.length === 0 ? (
          <ListEmpty docs="/docs/capabilities/email" icon={Globe02Icon} title="No domains">
            A tenant sends only from addresses on its verified domains.
          </ListEmpty>
        ) : (
          <Table dense>
            <TableHeader>
              <TableRow>
                <TableHead>Domain</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last checked</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {domains.map((domain) => (
                <TableRow key={domain.id}>
                  <TableCell>
                    <TextLink href={`${domainsPath}/${domain.id}`}>{domain.domain}</TextLink>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={domain.status} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {domain.lastCheckedAt ? <Timestamp value={domain.lastCheckedAt} /> : "Never"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
      {access.updateEmailTenant ? (
        <TenantStatusDialog
          onClose={close}
          open={dialog === "status"}
          scope={scope}
          tenant={tenant}
        />
      ) : null}
      {access.createEmailDomain ? (
        <CreateTenantDomainDialog
          onClose={close}
          open={dialog === "domain"}
          scope={scope}
          tenant={tenant}
        />
      ) : null}
      {access.sendEmail ? (
        <SendTenantEmailDialog
          domains={domains}
          onClose={close}
          open={dialog === "send"}
          scope={scope}
          tenant={tenant}
        />
      ) : null}
    </div>
  );
}

export function TenantDomainDetail({
  domainId,
  scope,
}: Readonly<{ domainId: string; scope: EnvironmentScope }>) {
  const queryClient = useQueryClient();
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const { data: domain } = useSuspenseQuery(tenantDomainQuery(scope, domainId));
  return (
    <DomainDetailView
      back={{
        href: `${environmentPath(scope)}/email/tenants/${domain.tenantId}`,
        label: "Sending tenant",
      }}
      canRefresh={shell.access.refreshEmailDomain}
      canRevoke={shell.access.revokeEmailDomain && domain.status !== "revoked"}
      domain={domain}
      facts={
        <>
          <DescriptionTerm>Tenant</DescriptionTerm>
          <DescriptionDetails>
            <TextLink href={`${environmentPath(scope)}/email/tenants/${domain.tenantId}`}>
              <PublicId value={domain.tenantId} />
            </TextLink>
          </DescriptionDetails>
        </>
      }
      invalidate={() => invalidateEmailTenants(queryClient, scope)}
      refresh={(idempotencyKey) =>
        refreshTenantDomainFn({ data: { domainId, idempotencyKey, scope } })
      }
      revoke={(idempotencyKey) =>
        revokeTenantDomainFn({ data: { domainId, idempotencyKey, scope } })
      }
      scope={scope}
    />
  );
}
