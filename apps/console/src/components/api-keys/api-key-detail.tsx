import { Activity01Icon, Key01Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { allowedKeyActions, keyState } from "../../api-keys/directory.ts";
import { KEY_OUTCOMES, RECENT_CALLS, type KeyOutcome } from "../../api-keys/usage.ts";
import { apiKeyQuery, keyUsageQuery } from "../../data/api-key-queries.ts";
import { organizationShellQuery } from "../../data/console-queries.ts";
import { formatExact } from "../../observability/format.ts";
import type { MetricRange } from "../../observability/range.ts";
import { formatCount } from "../../overview/status-counts.ts";
import type { EnvironmentScope } from "../../scope.ts";
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
import { Code, Text } from "@/components/ui/text";
import { Icon } from "../icon.tsx";
import { ListEmpty } from "../list-controls.tsx";
import { StatTile, Timestamp } from "../observability/panels.tsx";
import { RangeToggle } from "../observability/selection-controls.tsx";
import { PublicId } from "../public-id.tsx";
import { SectionBoundary } from "../section-boundary.tsx";
import { AccessDialogs, type AccessDialog } from "./api-key-dialogs.tsx";
import { ScopeChips } from "./api-key-directory.tsx";
import { StatusBadge } from "@/components/status-badge";

const OUTCOME_LABELS: Readonly<Record<KeyOutcome, string>> = {
  allowed: "Allowed",
  denied: "Denied",
  error: "Errors",
};

export function ApiKeyDetail({
  apiCredentialId,
  onWindow,
  scope,
  window,
}: Readonly<{
  apiCredentialId: string;
  onWindow: (window: MetricRange) => void;
  scope: EnvironmentScope;
  window: MetricRange;
}>) {
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const { data: lookup } = useSuspenseQuery(apiKeyQuery(scope, apiCredentialId));
  const [dialog, setDialog] = useState<AccessDialog>();
  if (lookup.kind === "missing") {
    return (
      <ListEmpty
        docs="/docs/capabilities/service-accounts-and-api-keys"
        icon={Key01Icon}
        title="API key not found"
      >
        This environment lists no API key with ID {apiCredentialId}.
      </ListEmpty>
    );
  }
  const { account, apiKey } = lookup;
  const state = keyState(apiKey, account, new Date());
  const actions = allowedKeyActions(state, shell.access);
  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-wrap items-center gap-3">
        <Heading>{apiKey.name}</Heading>
        <StatusBadge status={state} />
        <div className="ml-auto flex gap-3">
          {actions.includes("rotate") ? (
            <Button
              onClick={() => setDialog({ account, apiKey, kind: "rotate-key" })}
              variant="outline"
            >
              <Icon icon={RefreshIcon} />
              Rotate
            </Button>
          ) : null}
          {actions.includes("revoke") ? (
            <Button variant="destructive" onClick={() => setDialog({ apiKey, kind: "revoke-key" })}>
              Revoke
            </Button>
          ) : null}
        </div>
      </div>
      <DescriptionList>
        <DescriptionTerm>ID</DescriptionTerm>
        <DescriptionDetails>
          <PublicId value={apiKey.id} />
        </DescriptionDetails>
        <DescriptionTerm>Prefix</DescriptionTerm>
        <DescriptionDetails>
          <Code>{apiKey.keyPrefix}</Code>
        </DescriptionDetails>
        <DescriptionTerm>Service account</DescriptionTerm>
        <DescriptionDetails className="flex flex-wrap items-center gap-3">
          {account ? account.name : "Service account not found"}
          {account && account.status !== "active" ? <StatusBadge status={account.status} /> : null}
          <PublicId value={apiKey.serviceAccountId} />
        </DescriptionDetails>
        <DescriptionTerm>Scopes</DescriptionTerm>
        <DescriptionDetails>
          <ScopeChips scopes={apiKey.scopes} />
        </DescriptionDetails>
        <DescriptionTerm>Created</DescriptionTerm>
        <DescriptionDetails>
          <Timestamp value={apiKey.createdAt} />
        </DescriptionDetails>
        <DescriptionTerm>Expires</DescriptionTerm>
        <DescriptionDetails>
          {apiKey.expiresAt ? <Timestamp value={apiKey.expiresAt} /> : "Never"}
        </DescriptionDetails>
        {apiKey.revokedAt ? (
          <>
            <DescriptionTerm>Revoked</DescriptionTerm>
            <DescriptionDetails>
              <Timestamp value={apiKey.revokedAt} />
            </DescriptionDetails>
          </>
        ) : null}
      </DescriptionList>
      {shell.access.listApiCredentialUsage ? (
        <section className="flex flex-col gap-6">
          <div className="flex flex-wrap items-center gap-3">
            <Subheading>Usage</Subheading>
            <div className="ml-auto">
              <RangeToggle onChange={onWindow} value={window} />
            </div>
          </div>
          <SectionBoundary resetKey={`${apiKey.id}:${window}`}>
            <KeyUsage apiCredentialId={apiKey.id} scope={scope} window={window} />
          </SectionBoundary>
        </section>
      ) : null}
      <AccessDialogs dialog={dialog} onDialog={setDialog} scope={scope} />
    </div>
  );
}

function KeyUsage({
  apiCredentialId,
  scope,
  window,
}: Readonly<{ apiCredentialId: string; scope: EnvironmentScope; window: MetricRange }>) {
  const { data: usage } = useSuspenseQuery(keyUsageQuery(scope, apiCredentialId, window));
  const read = usage.counts.allowed + usage.counts.denied + usage.counts.error + usage.unreadable;
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-3">
        {KEY_OUTCOMES.map((outcome) => (
          <StatTile
            key={outcome}
            label={OUTCOME_LABELS[outcome]}
            value={formatCount(usage.counts[outcome], usage.complete)}
          />
        ))}
      </div>
      {usage.complete ? null : (
        <Text>
          Counts cover only the newest {formatExact(read)} usage records in this window; older
          records were not read.
        </Text>
      )}
      {usage.unreadable > 0 ? (
        <Text>
          {usage.unreadable === 1
            ? "1 usage record could not be read."
            : `${formatExact(usage.unreadable)} usage records could not be read.`}
        </Text>
      ) : null}
      {usage.recent.length === 0 ? (
        <ListEmpty
          docs="/docs/capabilities/service-accounts-and-api-keys"
          icon={Activity01Icon}
          title="No calls in this window"
        >
          Calls appear here once a backend authenticates with this key.
        </ListEmpty>
      ) : (
        <div className="flex flex-col gap-3">
          {usage.recent.length === RECENT_CALLS ? (
            <Text>The {RECENT_CALLS} newest calls.</Text>
          ) : null}
          <Table dense striped>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Request</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead>Reason</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {usage.recent.map((call, index) => (
                <TableRow key={`${call.createdAt}:${index}`}>
                  <TableCell className="whitespace-nowrap">
                    <Timestamp value={call.createdAt} />
                  </TableCell>
                  <TableCell>
                    <Code>
                      {call.requestMethod} {call.requestPath}
                    </Code>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={call.outcome} />
                  </TableCell>
                  <TableCell>{call.failureReason ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
