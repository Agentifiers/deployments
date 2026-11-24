import { Cancel01Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { environmentQuery } from "../../data/console-queries.ts";
import { DOMAIN_STEPS, type AgentEmailDomain } from "../../email/setup-state.ts";
import type { EnvironmentScope } from "../../scope.ts";
import { Button } from "@/components/ui/button";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
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
import { Text } from "@/components/ui/text";
import { ActionDialog, typedConfirmation } from "../action-dialog.tsx";
import { BackLink } from "../back-link.tsx";
import { Icon } from "../icon.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { StatusBadge } from "@/components/status-badge";

export type DomainFacts = Pick<
  AgentEmailDomain,
  | "dnsRecords"
  | "domain"
  | "failureReason"
  | "id"
  | "lastCheckedAt"
  | "mailFromDomain"
  | "status"
  | "verifiedAt"
>;

export function DnsRecordTable({ records }: Readonly<{ records: DomainFacts["dnsRecords"] }>) {
  if (records.length === 0) {
    return <Text>No records yet. A refresh creates the sending identity and lists them.</Text>;
  }
  return (
    <Table dense>
      <TableHeader>
        <TableRow>
          <TableHead>Type</TableHead>
          <TableHead>Name</TableHead>
          <TableHead>Value</TableHead>
          <TableHead className="text-right">Priority</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {records.map((record) => (
          <TableRow key={`${record.type}:${record.name}:${record.value}`}>
            <TableCell>{record.type}</TableCell>
            <TableCell className="font-mono text-xs/5 break-all">{record.name}</TableCell>
            <TableCell className="font-mono text-xs/5 break-all">{record.value}</TableCell>
            <TableCell className="text-right tabular-nums">{record.priority ?? "—"}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

type DomainAction = "refresh" | "revoke";

export function DomainDetailView({
  back,
  canRefresh,
  canRevoke,
  domain,
  facts,
  invalidate,
  refresh,
  revoke,
  scope,
}: Readonly<{
  back: { readonly href: string; readonly label: string };
  canRefresh: boolean;
  canRevoke: boolean;
  domain: DomainFacts;
  facts?: ReactNode;
  invalidate: () => unknown;
  refresh: (idempotencyKey: string) => Promise<unknown>;
  revoke: (idempotencyKey: string) => Promise<unknown>;
  scope: EnvironmentScope;
}>) {
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const [action, setAction] = useState<DomainAction>();
  const step = DOMAIN_STEPS[domain.status];
  return (
    <div className="flex flex-col gap-8">
      <BackLink href={back.href} label={back.label} />
      <div className="flex flex-wrap items-center gap-3">
        <Heading level={2}>{domain.domain}</Heading>
        <StatusBadge status={domain.status} />
        <div className="ml-auto flex flex-wrap gap-3">
          {canRefresh && step.refreshable ? (
            <Button onClick={() => setAction("refresh")} variant="outline">
              <Icon icon={RefreshIcon} />
              Refresh
            </Button>
          ) : null}
          {canRevoke ? (
            <Button variant="destructive" onClick={() => setAction("revoke")}>
              <Icon icon={Cancel01Icon} />
              Revoke
            </Button>
          ) : null}
        </div>
      </div>
      <Callout variant={domain.status === "failed" ? "destructive" : "default"}>
        <CalloutTitle>{step.title}</CalloutTitle>
        <CalloutDescription>
          <p>{step.next}</p>
          {domain.failureReason ? <p>{domain.failureReason}</p> : null}
        </CalloutDescription>
      </Callout>
      <DescriptionList>
        <DescriptionTerm>MAIL FROM domain</DescriptionTerm>
        <DescriptionDetails className="font-mono">{domain.mailFromDomain}</DescriptionDetails>
        {facts}
        <DescriptionTerm>Last checked</DescriptionTerm>
        <DescriptionDetails>
          {domain.lastCheckedAt ? <Timestamp value={domain.lastCheckedAt} /> : "Never"}
        </DescriptionDetails>
        <DescriptionTerm>Verified</DescriptionTerm>
        <DescriptionDetails>
          {domain.verifiedAt ? <Timestamp value={domain.verifiedAt} /> : "Not yet"}
        </DescriptionDetails>
        <DescriptionTerm>ID</DescriptionTerm>
        <DescriptionDetails>
          <PublicId value={domain.id} />
        </DescriptionDetails>
      </DescriptionList>
      <section className="flex flex-col gap-4">
        <Subheading>DNS records</Subheading>
        <DnsRecordTable records={domain.dnsRecords} />
      </section>
      <ActionDialog
        confirmLabel={action === "revoke" ? "Revoke domain" : "Refresh"}
        confirmation={typedConfirmation(environment.type, {
          destructive: action === "revoke",
          phrase: domain.domain,
        })}
        description={
          action === "revoke"
            ? "Revoking deletes the sending identity. Inboxes on this domain stop sending and receiving."
            : "Checks the published records with the email provider. The first refresh of a new domain creates its sending identity."
        }
        destructive={action === "revoke"}
        onClose={() => setAction(undefined)}
        onSuccess={() => void invalidate()}
        open={action !== undefined}
        run={(idempotencyKey) =>
          action === "revoke" ? revoke(idempotencyKey) : refresh(idempotencyKey)
        }
        successMessage={action === "revoke" ? "Domain revoked" : "Domain refreshed"}
        title={`${action === "revoke" ? "Revoke" : "Refresh"} ${domain.domain}`}
      />
    </div>
  );
}
