import { RepeatIcon } from "@hugeicons/core-free-icons";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { environmentQuery, organizationShellQuery } from "../../data/console-queries.ts";
import { retryDeliveryFn } from "../../data/webhook-mutations.ts";
import { deliveryQuery, invalidateWebhooks, webhookQuery } from "../../data/webhook-queries.ts";
import { formatExact } from "../../observability/format.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import { CodeBlock } from "@/components/reui/code-block/code-block";
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
import { Code, Text, TextLink } from "@/components/ui/text";
import {
  canRetryDelivery,
  isDeliveryInFlight,
  type AttemptView,
  type DeliveryView,
  type HeaderList,
} from "../../webhooks/webhook-state.ts";
import { ActionDialog, typedConfirmation } from "../action-dialog.tsx";
import { Icon } from "../icon.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { StatusBadge } from "@/components/status-badge";

const FAILURE_REASONS: Readonly<Record<NonNullable<DeliveryView["failureReason"]>, string>> = {
  "attempts-exhausted": "Every scheduled attempt failed",
  "endpoint-inactive": "The endpoint was disabled or archived",
  "event-unavailable": "The event is no longer available",
  "non-retryable": "The endpoint answered with a response that is not retried",
  "organization-suspended": "The organization was suspended",
};

const ATTEMPT_COLUMNS = 7;

function ResponseHeaders({ headers }: Readonly<{ headers: HeaderList }>) {
  if (headers.length === 0) return "None recorded";
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 font-mono text-xs/5">
      {headers.map(([name, value]) => (
        <Fragment key={name}>
          <dt className="text-muted-foreground">{name}</dt>
          <dd className="break-all whitespace-normal">{value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

function AttemptRows({ attempt }: Readonly<{ attempt: AttemptView }>) {
  const hasDetails =
    attempt.error !== undefined ||
    attempt.responseBodyExcerpt !== undefined ||
    attempt.responseHeaders.length > 0;
  return (
    <>
      <TableRow>
        <TableCell className="tabular-nums">{attempt.attempt}</TableCell>
        <TableCell>
          <StatusBadge status={attempt.outcome} />
        </TableCell>
        <TableCell className="text-right tabular-nums">{attempt.responseCode ?? "—"}</TableCell>
        <TableCell className="text-right tabular-nums">
          {formatExact(attempt.durationMs)} ms
        </TableCell>
        <TableCell className="whitespace-nowrap">
          <Timestamp value={attempt.startedAt} />
        </TableCell>
        <TableCell>{attempt.manual ? "Manual retry" : "Scheduled"}</TableCell>
        <TableCell className="whitespace-nowrap">
          {attempt.nextAttemptAt ? <Timestamp value={attempt.nextAttemptAt} /> : "—"}
        </TableCell>
      </TableRow>
      {hasDetails ? (
        <TableRow>
          <TableCell className="whitespace-normal" colSpan={ATTEMPT_COLUMNS}>
            <details>
              <summary className="cursor-pointer text-sm/6 text-muted-foreground">
                Response of attempt {attempt.attempt}
              </summary>
              <div className="mt-2 flex flex-col gap-3">
                {attempt.error ? <Text className="text-destructive">{attempt.error}</Text> : null}
                <ResponseHeaders headers={attempt.responseHeaders} />
                {attempt.responseBodyExcerpt ? (
                  <CodeBlock
                    code={attempt.responseBodyExcerpt}
                    defaultWrap
                    label={`Response body of attempt ${attempt.attempt}`}
                    maxLines={7}
                  />
                ) : null}
              </div>
            </details>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

export function DeliveryDetail({
  deliveryId,
  scope,
}: Readonly<{ deliveryId: string; scope: EnvironmentScope }>) {
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const {
    data: { attempts, delivery },
  } = useSuspenseQuery(deliveryQuery(scope, deliveryId));
  const { data: endpoint } = useQuery(webhookQuery(scope, delivery.webhookEndpointId));
  const [retrying, setRetrying] = useState(false);
  const mayRetry = shell.access.retryWebhookDelivery;
  const settled = !isDeliveryInFlight(delivery.status);
  const endpointPath = `${environmentPath(scope)}/webhooks/${delivery.webhookEndpointId}`;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <Heading level={2}>
          <Code>{delivery.eventType}</Code>
        </Heading>
        <StatusBadge status={delivery.status} />
        {mayRetry && canRetryDelivery(delivery, endpoint?.status) ? (
          <Button className="ml-auto" onClick={() => setRetrying(true)} variant="outline">
            <Icon icon={RepeatIcon} />
            Retry delivery
          </Button>
        ) : null}
      </div>
      {mayRetry && settled && endpoint && endpoint.status !== "active" ? (
        <Text>
          {endpoint.status === "disabled"
            ? "Enable the endpoint to retry this delivery."
            : "The endpoint is archived, so this delivery cannot be retried."}
        </Text>
      ) : null}
      {delivery.lastError ? (
        <Callout variant={delivery.status === "delivered" ? "default" : "destructive"}>
          <CalloutTitle>Last error</CalloutTitle>
          <CalloutDescription>{delivery.lastError}</CalloutDescription>
        </Callout>
      ) : null}
      <DescriptionList>
        <DescriptionTerm>ID</DescriptionTerm>
        <DescriptionDetails>
          <PublicId value={delivery.id} />
        </DescriptionDetails>
        <DescriptionTerm>Endpoint</DescriptionTerm>
        <DescriptionDetails>
          <TextLink href={endpointPath}>{endpoint?.name ?? delivery.webhookEndpointId}</TextLink>
        </DescriptionDetails>
        <DescriptionTerm>Event</DescriptionTerm>
        <DescriptionDetails>
          <PublicId value={delivery.eventId} />
        </DescriptionDetails>
        <DescriptionTerm>Resource</DescriptionTerm>
        <DescriptionDetails>
          <span className="inline-flex flex-wrap items-center gap-2">
            <Code>{delivery.aggregateType}</Code>
            <PublicId value={delivery.aggregateId} />
            version {delivery.aggregateVersion}
          </span>
        </DescriptionDetails>
        <DescriptionTerm>Attempt</DescriptionTerm>
        <DescriptionDetails>
          {delivery.attempt} of {delivery.maxAttempts}
        </DescriptionDetails>
        {delivery.failureReason ? (
          <>
            <DescriptionTerm>Failure reason</DescriptionTerm>
            <DescriptionDetails>{FAILURE_REASONS[delivery.failureReason]}</DescriptionDetails>
          </>
        ) : null}
        <DescriptionTerm>Response status</DescriptionTerm>
        <DescriptionDetails>{delivery.responseCode ?? "—"}</DescriptionDetails>
        <DescriptionTerm>Response headers</DescriptionTerm>
        <DescriptionDetails>
          <ResponseHeaders headers={delivery.responseHeaders} />
        </DescriptionDetails>
        {delivery.lastAttemptAt ? (
          <>
            <DescriptionTerm>Last attempt</DescriptionTerm>
            <DescriptionDetails>
              <Timestamp value={delivery.lastAttemptAt} />
            </DescriptionDetails>
          </>
        ) : null}
        {delivery.nextAttemptAt ? (
          <>
            <DescriptionTerm>Next attempt</DescriptionTerm>
            <DescriptionDetails>
              <Timestamp value={delivery.nextAttemptAt} />
            </DescriptionDetails>
          </>
        ) : null}
        {delivery.manualRetryRequestedAt ? (
          <>
            <DescriptionTerm>Manual retry requested</DescriptionTerm>
            <DescriptionDetails>
              <Timestamp value={delivery.manualRetryRequestedAt} />
            </DescriptionDetails>
          </>
        ) : null}
        <DescriptionTerm>Created</DescriptionTerm>
        <DescriptionDetails>
          <Timestamp value={delivery.createdAt} />
        </DescriptionDetails>
        <DescriptionTerm>Kept until</DescriptionTerm>
        <DescriptionDetails>
          <Timestamp value={delivery.retentionExpiresAt} />
        </DescriptionDetails>
      </DescriptionList>
      <section className="flex flex-col gap-4">
        <Subheading>Attempts</Subheading>
        {attempts.length === 0 ? (
          <Text>No attempt has been made yet.</Text>
        ) : (
          <Table dense>
            <TableHeader>
              <TableRow>
                <TableHead>Attempt</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead className="text-right">Response</TableHead>
                <TableHead className="text-right">Duration</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Trigger</TableHead>
                <TableHead>Next attempt</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {attempts.map((attempt) => (
                <AttemptRows attempt={attempt} key={`${attempt.attempt}:${attempt.startedAt}`} />
              ))}
            </TableBody>
          </Table>
        )}
      </section>
      {mayRetry ? (
        <RetryDeliveryDialog
          delivery={delivery}
          onClose={() => setRetrying(false)}
          open={retrying}
          scope={scope}
        />
      ) : null}
    </div>
  );
}

function RetryDeliveryDialog({
  delivery,
  onClose,
  open,
  scope,
}: Readonly<{
  delivery: DeliveryView;
  onClose: () => void;
  open: boolean;
  scope: EnvironmentScope;
}>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  return (
    <ActionDialog
      confirmLabel="Retry delivery"
      confirmation={typedConfirmation(environment.type, { phrase: delivery.eventType })}
      description="Queues one more attempt to send this event to the endpoint. The endpoint receives the same event again."
      onClose={onClose}
      onSuccess={() => void invalidateWebhooks(queryClient, scope)}
      open={open}
      runOnce={() => retryDeliveryFn({ data: { deliveryId: delivery.id, scope } })}
      successMessage="Delivery queued for another attempt"
      title="Retry this delivery?"
    />
  );
}
