import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { environmentQuery } from "../../data/console-queries.ts";
import {
  archiveWebhookFn,
  createWebhookFn,
  disableWebhookFn,
  enableWebhookFn,
  rotateWebhookSecretFn,
  testWebhookFn,
  updateWebhookFn,
} from "../../data/webhook-mutations.ts";
import { invalidateWebhooks } from "../../data/webhook-queries.ts";
import type { EnvironmentScope } from "../../scope.ts";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import { Checkbox } from "@/components/ui/checkbox";
import { CheckboxField, Description, ErrorMessage, Field, Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Code } from "@/components/ui/text";
import { Textarea } from "@/components/ui/textarea";
import { ALL_EVENT_TYPES } from "../../webhooks/event-types.ts";
import {
  DEFAULT_OVERLAP_HOURS,
  endpointChanges,
  MAX_OVERLAP_HOURS,
  parseOverlapHours,
  readEndpointDraft,
  type EndpointDraft,
  type WebhookEndpoint,
  type WebhookTestResult,
} from "../../webhooks/webhook-state.ts";
import { ActionDialog, typedConfirmation } from "../action-dialog.tsx";
import { DocsLink } from "../docs-link.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { SecretActionDialog } from "../secret-action-dialog.tsx";

const EMPTY_DRAFT: EndpointDraft = { all: false, eventTypes: "", name: "", url: "" };

function draftOf(endpoint: WebhookEndpoint): EndpointDraft {
  const all = endpoint.eventTypes.includes(ALL_EVENT_TYPES);
  return {
    all,
    eventTypes: all ? "" : endpoint.eventTypes.join("\n"),
    name: endpoint.name,
    url: endpoint.url,
  };
}

function EndpointFields({
  draft,
  onChange,
}: Readonly<{ draft: EndpointDraft; onChange: (draft: EndpointDraft) => void }>) {
  const { eventTypes, nameValid, urlValid } = readEndpointDraft(draft);
  return (
    <>
      <Field>
        <Label>Name</Label>
        <Input
          autoComplete="off"
          aria-invalid={draft.name !== "" && !nameValid}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
          value={draft.name}
        />
        {draft.name !== "" && !nameValid ? (
          <ErrorMessage>Use 1 to 120 characters.</ErrorMessage>
        ) : null}
      </Field>
      <Field>
        <Label>URL</Label>
        <Description>
          A public HTTPS address. Every request the platform sends is signed.
        </Description>
        <Input
          autoComplete="off"
          aria-invalid={draft.url !== "" && !urlValid}
          onChange={(event) => onChange({ ...draft, url: event.target.value })}
          placeholder="https://hooks.example.com/deployments"
          type="url"
          value={draft.url}
        />
        {draft.url !== "" && !urlValid ? (
          <ErrorMessage>Enter a full address that starts with https://.</ErrorMessage>
        ) : null}
      </Field>
      <Field disabled={draft.all}>
        <Label>Event types</Label>
        <Description>
          Separated by commas or new lines, such as <Code>run.completed</Code>,{" "}
          <Code>run.failed</Code>, or <Code>webhook.endpoint.disabled</Code>.
        </Description>
        <Textarea
          className="font-mono"
          aria-invalid={!draft.all && draft.eventTypes.trim() !== "" && !eventTypes.ok}
          onChange={(event) => onChange({ ...draft, eventTypes: event.target.value })}
          rows={4}
          value={draft.eventTypes}
        />
        {!draft.all && draft.eventTypes.trim() !== "" && !eventTypes.ok ? (
          <ErrorMessage>{eventTypes.message}</ErrorMessage>
        ) : null}
      </Field>
      <CheckboxField>
        <Checkbox checked={draft.all} onCheckedChange={(all) => onChange({ ...draft, all })} />
        <Label>All events</Label>
        <Description>Every event type, including types added later.</Description>
      </CheckboxField>
    </>
  );
}

export function CreateWebhookDialog({
  onClose,
  open,
  scope,
}: Readonly<{ onClose: () => void; open: boolean; scope: EnvironmentScope }>) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  useEffect(() => {
    if (open) setDraft(EMPTY_DRAFT);
  }, [open]);
  const request = readEndpointDraft(draft).value;

  return (
    <SecretActionDialog<WebhookEndpoint>
      confirmLabel="Create endpoint"
      confirmation={typedConfirmation(environment.type, {
        phrase: draft.name.trim() || "create",
      })}
      description="The platform sends signed events to this URL. Resource filters are set through the API."
      invalid={request === undefined}
      onClose={onClose}
      onIssued={() => void invalidateWebhooks(queryClient, scope)}
      onStored={(endpoint) =>
        void navigate({
          params: {
            envId: scope.environmentId,
            orgId: scope.organizationId,
            projectId: scope.projectId,
            webhookId: endpoint.id,
          },
          to: "/o/$orgId/p/$projectId/e/$envId/webhooks/$webhookId",
        })
      }
      open={open}
      runOnce={() => {
        if (!request) throw new TypeError("The endpoint form is incomplete.");
        return createWebhookFn({ data: { body: request, scope } });
      }}
      secretDescription={(endpoint) => (
        <>
          The receiver at <Code>{endpoint.url}</Code> verifies every delivery's signature with this
          secret.
        </>
      )}
      secretLabel="signing secret"
      size="xl"
      successMessage="Webhook endpoint created"
      title="Create webhook endpoint"
    >
      <EndpointFields draft={draft} onChange={setDraft} />
    </SecretActionDialog>
  );
}

export function EditWebhookDialog({
  endpoint,
  onClose,
  open,
  scope,
}: Readonly<{
  endpoint: WebhookEndpoint;
  onClose: () => void;
  open: boolean;
  scope: EnvironmentScope;
}>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const [endpointAtOpen, setEndpointAtOpen] = useState(endpoint);
  const [draft, setDraft] = useState(() => draftOf(endpoint));
  useEffect(() => {
    if (!open) return;
    setEndpointAtOpen(endpoint);
    setDraft(draftOf(endpoint));
  }, [open]);
  const request = readEndpointDraft(draft).value;
  const changes = request ? endpointChanges(endpointAtOpen, request) : {};

  return (
    <ActionDialog
      confirmLabel="Save changes"
      confirmation={typedConfirmation(environment.type, { phrase: endpoint.name })}
      description={
        endpoint.resourceFilters ? (
          <>
            Resource filters stay as they are.{" "}
            <DocsLink path="/docs/api/reference/runtime/update-webhook/">
              Change them through the API
            </DocsLink>
            .
          </>
        ) : undefined
      }
      invalid={request === undefined || Object.keys(changes).length === 0}
      onClose={onClose}
      onSuccess={() => void invalidateWebhooks(queryClient, scope)}
      open={open}
      runOnce={() => updateWebhookFn({ data: { body: changes, scope, webhookId: endpoint.id } })}
      size="xl"
      successMessage="Webhook endpoint updated"
      title={`Edit ${endpoint.name}`}
    >
      <EndpointFields draft={draft} onChange={setDraft} />
    </ActionDialog>
  );
}

export type StatusChange = "archive" | "disable" | "enable";

const STATUS_CHANGES: Readonly<
  Record<
    StatusChange,
    {
      readonly confirmLabel: string;
      readonly description: string;
      readonly destructive: boolean;
      readonly run: typeof disableWebhookFn;
      readonly successMessage: string;
      readonly verb: string;
    }
  >
> = {
  archive: {
    confirmLabel: "Archive endpoint",
    description:
      "Archiving stops every delivery, revokes the signing secret, and frees the endpoint's slot. It cannot be undone.",
    destructive: true,
    run: archiveWebhookFn,
    successMessage: "Webhook endpoint archived",
    verb: "Archive",
  },
  disable: {
    confirmLabel: "Disable endpoint",
    description:
      "Events that occur while the endpoint is disabled are never delivered, even after you enable it again, and its pending retries fail. It keeps its signing secret.",
    destructive: false,
    run: disableWebhookFn,
    successMessage: "Webhook endpoint disabled",
    verb: "Disable",
  },
  enable: {
    confirmLabel: "Enable endpoint",
    description:
      "Enabling resumes deliveries and resets the failure counter. Events from the disabled period are not delivered; retry failed deliveries by hand.",
    destructive: false,
    run: enableWebhookFn,
    successMessage: "Webhook endpoint enabled",
    verb: "Enable",
  },
};

export function ChangeStatusDialog({
  change,
  endpoint,
  onClose,
  open,
  scope,
}: Readonly<{
  change: StatusChange;
  endpoint: WebhookEndpoint;
  onClose: () => void;
  open: boolean;
  scope: EnvironmentScope;
}>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const copy = STATUS_CHANGES[change];
  return (
    <ActionDialog
      confirmLabel={copy.confirmLabel}
      confirmation={typedConfirmation(environment.type, {
        destructive: copy.destructive,
        phrase: endpoint.name,
      })}
      description={copy.description}
      destructive={copy.destructive}
      onClose={onClose}
      onSuccess={() => void invalidateWebhooks(queryClient, scope)}
      open={open}
      runOnce={() => copy.run({ data: { scope, webhookId: endpoint.id } })}
      successMessage={copy.successMessage}
      title={`${copy.verb} ${endpoint.name}?`}
    />
  );
}

export function TestWebhookDialog({
  endpoint,
  onClose,
  onResult,
  open,
  scope,
}: Readonly<{
  endpoint: WebhookEndpoint;
  onClose: () => void;
  onResult: (result: WebhookTestResult) => void;
  open: boolean;
  scope: EnvironmentScope;
}>) {
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  return (
    <ActionDialog
      confirmLabel="Send test event"
      confirmation={typedConfirmation(environment.type, { phrase: endpoint.name })}
      description={
        <>
          Sends one signed <Code>webhook.test</Code> event to <Code>{endpoint.url}</Code> and waits
          up to 10 seconds for the response. Test events are not recorded as deliveries.
        </>
      }
      onClose={onClose}
      onSuccess={onResult}
      open={open}
      runOnce={() => testWebhookFn({ data: { scope, webhookId: endpoint.id } })}
      successMessage={(result) =>
        result.delivered ? "Test event delivered" : "The endpoint did not accept the test event"
      }
      title={`Test ${endpoint.name}`}
    />
  );
}

export function RotateSecretDialog({
  endpoint,
  onClose,
  open,
  scope,
}: Readonly<{
  endpoint: WebhookEndpoint;
  onClose: () => void;
  open: boolean;
  scope: EnvironmentScope;
}>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const [hours, setHours] = useState(String(DEFAULT_OVERLAP_HOURS));
  useEffect(() => {
    if (open) setHours(String(DEFAULT_OVERLAP_HOURS));
  }, [open]);
  const overlap = parseOverlapHours(hours);
  const previousExpiresAt = endpoint.previousSigningSecretExpiresAt;
  const overlapRunning =
    previousExpiresAt !== undefined && Date.parse(previousExpiresAt) > Date.now();

  return (
    <SecretActionDialog<WebhookEndpoint>
      confirmLabel="Rotate secret"
      confirmation={typedConfirmation(environment.type, {
        destructive: true,
        phrase: endpoint.name,
      })}
      description="The new secret signs every delivery from now on. During the overlap the current secret signs too, as a second signature, so receivers can switch without failing verification."
      invalid={!overlap.ok}
      onClose={onClose}
      onIssued={() => void invalidateWebhooks(queryClient, scope)}
      onStored={() => undefined}
      open={open}
      runOnce={() => {
        if (!overlap.ok) throw new TypeError(overlap.message);
        return rotateWebhookSecretFn({
          data: {
            body: { previousSecretExpiresInSeconds: overlap.seconds },
            scope,
            webhookId: endpoint.id,
          },
        });
      }}
      secretDescription={(rotated) =>
        rotated.previousSigningSecretExpiresAt ? (
          <>
            The previous secret keeps signing until{" "}
            <Timestamp value={rotated.previousSigningSecretExpiresAt} />. Update the receiver before
            then.
          </>
        ) : (
          "The previous secret stopped signing. Update the receiver now."
        )
      }
      secretLabel="signing secret"
      successMessage="Signing secret rotated"
      title={`Rotate the signing secret of ${endpoint.name}`}
    >
      {overlapRunning ? (
        <Callout variant="destructive">
          <CalloutTitle>An earlier rotation is still overlapping</CalloutTitle>
          <CalloutDescription>
            The secret before the current one signs until <Timestamp value={previousExpiresAt} />.
            Rotating again stops it at once, so receivers still verifying with it start failing.
          </CalloutDescription>
        </Callout>
      ) : null}
      <Field>
        <Label>Overlap in hours</Label>
        <Description>
          How long the current secret keeps signing beside the new one, from 0 to{" "}
          {MAX_OVERLAP_HOURS}. 0 stops it at once.
        </Description>
        <Input
          autoComplete="off"
          inputMode="numeric"
          aria-invalid={!overlap.ok}
          onChange={(event) => setHours(event.target.value)}
          value={hours}
        />
      </Field>
    </SecretActionDialog>
  );
}
