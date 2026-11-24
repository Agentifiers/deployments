import {
  Archive02Icon,
  Key01Icon,
  PauseIcon,
  PencilEdit02Icon,
  PlayIcon,
  SentIcon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { ConsoleOperation } from "../../access.ts";
import { organizationShellQuery } from "../../data/console-queries.ts";
import { webhookQuery } from "../../data/webhook-queries.ts";
import { formatExact } from "../../observability/format.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import { Button } from "@/components/ui/button";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { Heading, Subheading } from "@/components/ui/heading";
import { Code, TextLink } from "@/components/ui/text";
import { formatEventTypes } from "../../webhooks/event-types.ts";
import {
  ENDPOINT_ACTIONS,
  type EndpointAction,
  type WebhookEndpoint,
  type WebhookTestResult,
} from "../../webhooks/webhook-state.ts";
import { Icon } from "../icon.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { SectionBoundary } from "../section-boundary.tsx";
import { DeliveryTable } from "./delivery-table.tsx";
import {
  ChangeStatusDialog,
  EditWebhookDialog,
  RotateSecretDialog,
  TestWebhookDialog,
} from "./webhook-dialogs.tsx";
import { StatusBadge } from "@/components/status-badge";

const ACTION_CONTROLS: Readonly<
  Record<
    EndpointAction,
    { readonly icon: IconSvgElement; readonly label: string; readonly operation: ConsoleOperation }
  >
> = {
  archive: { icon: Archive02Icon, label: "Archive", operation: "archiveWebhook" },
  disable: { icon: PauseIcon, label: "Disable", operation: "disableWebhook" },
  edit: { icon: PencilEdit02Icon, label: "Edit", operation: "updateWebhook" },
  enable: { icon: PlayIcon, label: "Enable", operation: "enableWebhook" },
  rotate: { icon: Key01Icon, label: "Rotate secret", operation: "rotateWebhookSecret" },
  test: { icon: SentIcon, label: "Send test", operation: "testWebhook" },
};

const DISABLED_REASONS: Readonly<Record<NonNullable<WebhookEndpoint["disabledReason"]>, string>> = {
  "consecutive-failures": "after repeated failed deliveries",
  manual: "manually",
};

type ResourceFilters = NonNullable<WebhookEndpoint["resourceFilters"]>;

const RESOURCE_FILTER_FAMILIES = [
  ["aggregateTypes", "Aggregate types"],
  ["aggregateIds", "Aggregate IDs"],
  ["projectIds", "Projects"],
  ["environmentIds", "Environments"],
] as const satisfies readonly (readonly [keyof ResourceFilters, string])[];

function ResourceFilterList({ filters }: Readonly<{ filters: ResourceFilters | undefined }>) {
  const families = RESOURCE_FILTER_FAMILIES.filter(([key]) => filters?.[key]?.length);
  if (!filters || families.length === 0) return "None";
  return (
    <ul className="flex flex-col gap-1">
      {families.map(([key, label]) => (
        <li key={key}>
          {label}: <Code>{filters[key]?.join(", ")}</Code>
        </li>
      ))}
    </ul>
  );
}

function TestResultCallout({ result }: Readonly<{ result: WebhookTestResult }>) {
  const response =
    result.responseStatus === undefined ? "No response" : `HTTP ${result.responseStatus}`;
  return (
    <Callout variant={result.delivered ? "default" : "destructive"}>
      <CalloutTitle>
        {result.delivered ? "Test event delivered" : "Test event not delivered"}
      </CalloutTitle>
      <CalloutDescription>
        <p>
          {response} after {formatExact(result.durationMs)} ms. Event <Code>{result.eventId}</Code>.
        </p>
        {result.error ? <p>{result.error}</p> : null}
      </CalloutDescription>
    </Callout>
  );
}

export function WebhookDetail({
  scope,
  webhookId,
}: Readonly<{ scope: EnvironmentScope; webhookId: string }>) {
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const { data: endpoint } = useSuspenseQuery(webhookQuery(scope, webhookId));
  const [dialog, setDialog] = useState<EndpointAction>();
  const [testResult, setTestResult] = useState<WebhookTestResult>();
  const { access } = shell;
  const actions = ENDPOINT_ACTIONS[endpoint.status].filter(
    (action) => access[ACTION_CONTROLS[action].operation],
  );
  const close = () => setDialog(undefined);
  const feedPath = `${environmentPath(scope)}/webhooks/deliveries?webhookId=${endpoint.id}`;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <Heading level={2}>{endpoint.name}</Heading>
        <StatusBadge status={endpoint.status} />
        <div className="ml-auto flex flex-wrap gap-3">
          {actions.map((action) => {
            const { icon, label } = ACTION_CONTROLS[action];
            const content = (
              <>
                <Icon icon={icon} />
                {label}
              </>
            );
            return action === "archive" ? (
              <Button variant="destructive" key={action} onClick={() => setDialog(action)}>
                {content}
              </Button>
            ) : (
              <Button key={action} onClick={() => setDialog(action)} variant="outline">
                {content}
              </Button>
            );
          })}
        </div>
      </div>
      {testResult ? <TestResultCallout result={testResult} /> : null}
      <DescriptionList>
        <DescriptionTerm>ID</DescriptionTerm>
        <DescriptionDetails>
          <PublicId value={endpoint.id} />
        </DescriptionDetails>
        <DescriptionTerm>URL</DescriptionTerm>
        <DescriptionDetails>
          <Code>{endpoint.url}</Code>
        </DescriptionDetails>
        <DescriptionTerm>Event types</DescriptionTerm>
        <DescriptionDetails>{formatEventTypes(endpoint.eventTypes)}</DescriptionDetails>
        <DescriptionTerm>Resource filters</DescriptionTerm>
        <DescriptionDetails>
          <ResourceFilterList filters={endpoint.resourceFilters} />
        </DescriptionDetails>
        <DescriptionTerm>Consecutive failures</DescriptionTerm>
        <DescriptionDetails>{formatExact(endpoint.consecutiveFailures)}</DescriptionDetails>
        {endpoint.disabledAt ? (
          <>
            <DescriptionTerm>Disabled</DescriptionTerm>
            <DescriptionDetails>
              <Timestamp value={endpoint.disabledAt} />
              {endpoint.disabledReason ? `, ${DISABLED_REASONS[endpoint.disabledReason]}` : null}
            </DescriptionDetails>
          </>
        ) : null}
        <DescriptionTerm>Signing secret</DescriptionTerm>
        <DescriptionDetails>
          {endpoint.signingSecretRotatedAt ? (
            <>
              Rotated <Timestamp value={endpoint.signingSecretRotatedAt} />
            </>
          ) : (
            "Not rotated since the endpoint was created"
          )}
        </DescriptionDetails>
        {endpoint.previousSigningSecretExpiresAt ? (
          <>
            <DescriptionTerm>Previous secret</DescriptionTerm>
            <DescriptionDetails>
              Co-signs until <Timestamp value={endpoint.previousSigningSecretExpiresAt} />
            </DescriptionDetails>
          </>
        ) : null}
        <DescriptionTerm>Created</DescriptionTerm>
        <DescriptionDetails>
          <Timestamp value={endpoint.createdAt} />
        </DescriptionDetails>
        <DescriptionTerm>Updated</DescriptionTerm>
        <DescriptionDetails>
          <Timestamp value={endpoint.updatedAt} />
        </DescriptionDetails>
      </DescriptionList>
      {access.listWebhookDeliveries ? (
        <section className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <Subheading>Deliveries</Subheading>
            <TextLink className="ml-auto text-sm/6" href={feedPath}>
              Open in the delivery feed
            </TextLink>
          </div>
          <SectionBoundary resetKey={endpoint.id}>
            <DeliveryTable filters={{ webhookId: endpoint.id }} scope={scope} />
          </SectionBoundary>
        </section>
      ) : null}
      {access.updateWebhook ? (
        <EditWebhookDialog
          endpoint={endpoint}
          onClose={close}
          open={dialog === "edit"}
          scope={scope}
        />
      ) : null}
      {access.testWebhook ? (
        <TestWebhookDialog
          endpoint={endpoint}
          onClose={close}
          onResult={setTestResult}
          open={dialog === "test"}
          scope={scope}
        />
      ) : null}
      {access.rotateWebhookSecret ? (
        <RotateSecretDialog
          endpoint={endpoint}
          onClose={close}
          open={dialog === "rotate"}
          scope={scope}
        />
      ) : null}
      {(["archive", "disable", "enable"] as const).map((change) =>
        access[ACTION_CONTROLS[change].operation] ? (
          <ChangeStatusDialog
            change={change}
            endpoint={endpoint}
            key={change}
            onClose={close}
            open={dialog === change}
            scope={scope}
          />
        ) : null,
      )}
    </div>
  );
}
