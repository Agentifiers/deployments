import { useSuspenseQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { OperationAccess } from "../../access.ts";
import {
  channelIngressUrl,
  createThreadSnippet,
  docsUrl,
  streamThreadSnippet,
  submitRunSnippet,
  type IntegrationEndpoints,
} from "../../integrations/endpoints.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import type { DeploymentTarget } from "../../server/agent-email-inbox-data.ts";
import { CodeBlock, CodeBlockCopyButton } from "@/components/reui/code-block/code-block";
import { Field, Label } from "@/components/ui/field";
import { Subheading } from "@/components/ui/heading";
import { NativeSelect } from "@/components/ui/native-select";
import { Code, Text, TextLink } from "@/components/ui/text";
import { deploymentTargetsQuery } from "../../data/agent-email-inbox-queries.ts";

/** Event types a product integration usually subscribes to first. */
const STARTER_EVENT_TYPES = [
  "run.completed",
  "run.failed",
  "run.canceled",
  "channel.message.received",
  "channel.delivery.failed",
] as const;

function Step({
  children,
  docs,
  endpoints,
  title,
}: Readonly<{
  children: ReactNode;
  docs?: `/docs/${string}`;
  endpoints: IntegrationEndpoints;
  title: string;
}>) {
  const href = docs ? docsUrl(endpoints, docs) : undefined;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-3">
        <Subheading>{title}</Subheading>
        {href ? (
          <TextLink className="ml-auto text-sm/6" href={href} rel="noreferrer" target="_blank">
            Guide
          </TextLink>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/**
 * Everything a customer's product needs to connect to this environment: where to send work, how
 * to read the output live, where events arrive, and where channel providers post. Values come
 * from the install's configuration and the environment's running deployments.
 */
export function IntegratePage({
  access,
  deploymentId,
  endpoints,
  onDeployment,
  scope,
}: Readonly<{
  access: OperationAccess;
  deploymentId: string | undefined;
  endpoints: IntegrationEndpoints;
  onDeployment: (deploymentId: string | undefined) => void;
  scope: EnvironmentScope;
}>) {
  const base = environmentPath(scope);
  return (
    <div className="flex max-w-4xl flex-col gap-10">
      <Step docs="/docs/sdk/authentication" endpoints={endpoints} title="Authenticate">
        <Text>
          Your backend calls the platform API with a service-account API key as a bearer token. A
          key belongs to this environment, so requests need no tenant headers.{" "}
          {access.listServiceAccounts && access.listApiCredentials ? (
            <TextLink href={`${base}/api-keys`}>Create or rotate a key under API keys</TextLink>
          ) : (
            "An owner or admin issues keys under API keys"
          )}
          . Give it <Code>runs:write</Code> to send work and <Code>runs:read</Code> to stream.
        </Text>
        <CodeBlock code={endpoints.platformApi} defaultWrap label="Platform API URL">
          <CodeBlockCopyButton alwaysVisible labels={{ copy: "Copy Platform API URL" }} />
        </CodeBlock>
      </Step>

      <Step docs="/docs/capabilities/threads-and-runs" endpoints={endpoints} title="Send work in">
        {access.listAgentDeployments ? (
          <SubmitRun
            deploymentId={deploymentId}
            endpoints={endpoints}
            onDeployment={onDeployment}
            scope={scope}
          />
        ) : (
          <Text>Listing deployments needs agents:read.</Text>
        )}
      </Step>

      <Step docs="/docs/sdk/streaming" endpoints={endpoints} title="Stream the output">
        <Text>
          A run&apos;s tokens, tool calls, and status go to its thread&apos;s stream. Open a stream
          session for the thread, then read its <Code>streamUrl</Code> with the session&apos;s
          token. The token lasts five minutes; open a new session and resume from the last offset.
        </Text>
        {endpoints.streamGateway ? (
          <CodeBlock code={endpoints.streamGateway} defaultWrap label="Stream gateway URL">
            <CodeBlockCopyButton alwaysVisible labels={{ copy: "Copy Stream gateway URL" }} />
          </CodeBlock>
        ) : null}
        <CodeBlock
          code={streamThreadSnippet(endpoints)}
          defaultWrap
          label="Stream a thread"
          language="shell"
        >
          <CodeBlockCopyButton alwaysVisible labels={{ copy: "Copy Stream a thread" }} />
        </CodeBlock>
      </Step>

      <Step docs="/docs/capabilities/webhooks" endpoints={endpoints} title="Receive events">
        <Text>
          A webhook endpoint receives a signed <Code>POST</Code> for each event it subscribes to.
          Common first subscriptions:{" "}
          {STARTER_EVENT_TYPES.map((type, index) => (
            <span key={type}>
              {index > 0 ? ", " : null}
              <Code>{type}</Code>
            </span>
          ))}
          .{" "}
          {access.listWebhooks ? (
            <TextLink href={`${base}/webhooks`}>Add an endpoint under Webhooks</TextLink>
          ) : (
            "An owner or admin adds endpoints under Webhooks"
          )}
          .
        </Text>
      </Step>

      {endpoints.channelApi ? (
        <Step docs="/docs/capabilities/channels" endpoints={endpoints} title="Channel ingress">
          <Text>
            A channel binding gives a provider a URL to post inbound messages to. Each binding shows
            its own URL on its agent&apos;s Channels tab. Bindings are created through the API.
          </Text>
          <CodeBlock
            code={channelIngressUrl(endpoints.channelApi, {
              environmentId: scope.environmentId,
              id: "{bindingId}",
              organizationId: scope.organizationId,
              provider: "{provider}",
            })}
            defaultWrap
            label="Channel ingress URL pattern"
          >
            <CodeBlockCopyButton
              alwaysVisible
              labels={{ copy: "Copy Channel ingress URL pattern" }}
            />
          </CodeBlock>
        </Step>
      ) : null}
    </div>
  );
}

function SubmitRun({
  deploymentId,
  endpoints,
  onDeployment,
  scope,
}: Readonly<{
  deploymentId: string | undefined;
  endpoints: IntegrationEndpoints;
  onDeployment: (deploymentId: string | undefined) => void;
  scope: EnvironmentScope;
}>) {
  const { data: targets } = useSuspenseQuery(deploymentTargetsQuery(scope));
  const selected: DeploymentTarget | undefined =
    targets.find((target) => target.id === deploymentId) ?? targets[0];
  if (!selected) {
    return (
      <Text>
        No deployment is running in this environment.{" "}
        <TextLink href={`${environmentPath(scope)}/agents`}>Deploy an agent</TextLink> to get a
        deployment to send work to.
      </Text>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <Field>
        <Label>Deployment</Label>
        <NativeSelect
          onChange={(event) => onDeployment(event.target.value || undefined)}
          value={selected.id}
        >
          {targets.map((target) => (
            <option key={target.id} value={target.id}>
              {target.agentName} · {target.id}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Text>
        Each run starts a new thread unless the body names a <Code>threadId</Code>. The response
        holds the <Code>run</Code>, its <Code>thread</Code>, and the accepted <Code>message</Code>.
        Reuse an idempotency key to retry safely.
      </Text>
      <CodeBlock
        code={submitRunSnippet({ deploymentId: selected.id, endpoints })}
        defaultWrap
        label="Submit a run"
        language="shell"
      >
        <CodeBlockCopyButton alwaysVisible labels={{ copy: "Copy Submit a run" }} />
      </CodeBlock>
      <Text>
        To keep a conversation going, create a thread first and pass its ID with each run.
      </Text>
      <CodeBlock
        code={createThreadSnippet({ deploymentId: selected.id, endpoints })}
        defaultWrap
        label="Create a thread"
        language="shell"
      >
        <CodeBlockCopyButton alwaysVisible labels={{ copy: "Copy Create a thread" }} />
      </CodeBlock>
    </div>
  );
}
