/**
 * The public origins a customer's product talks to, as the console Lambda's environment names
 * them. Only `platformApi` is always configured; an origin the install does not run is absent and
 * its section is not shown.
 */
export interface IntegrationEndpoints {
  /** Platform API origin: runs, threads, stream sessions, webhooks, and API keys. */
  readonly platformApi: string;
  /** Stream gateway origin serving each thread's `streamUrl`. */
  readonly streamGateway?: string;
  /** Channel/provider public API origin serving channel ingress. */
  readonly channelApi?: string;
  /** Documentation site origin. */
  readonly docs?: string;
}

const PUBLIC_ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;

/** A docs page URL, or undefined when the install has no docs site to link to. */
export function docsUrl(endpoints: Pick<IntegrationEndpoints, "docs">, path: `/docs/${string}`) {
  return endpoints.docs ? `${endpoints.docs}${path}` : undefined;
}

/** The URL a provider posts a binding's inbound messages to. */
export function channelIngressUrl(
  channelApi: string,
  binding: {
    readonly environmentId: string;
    readonly id: string;
    readonly organizationId: string;
    readonly provider: string;
  },
) {
  return `${channelApi}/public/channels/${binding.organizationId}/${binding.environmentId}/${binding.id}/${binding.provider}`;
}

export interface SubmitRunSnippetInput {
  readonly deploymentId: string;
  readonly endpoints: Pick<IntegrationEndpoints, "platformApi">;
}

/**
 * `POST /v1/agent-deployments/:id/runs` with an environment API key. The key already names its
 * environment, so the tenant headers are optional and left out; the idempotency key is required.
 */
export function submitRunSnippet({ deploymentId, endpoints }: SubmitRunSnippetInput) {
  if (!PUBLIC_ID.test(deploymentId)) throw new TypeError("deploymentId must be a ULID.");
  return [
    `curl -sS -X POST "${endpoints.platformApi}/v1/agent-deployments/${deploymentId}/runs" \\`,
    `  -H "authorization: Bearer $DEPLOYMENTS_API_KEY" \\`,
    `  -H "idempotency-key: $(uuidgen)" \\`,
    `  -H "content-type: application/json" \\`,
    `  -d '{"content": "Hello"}'`,
  ].join("\n");
}

/** `POST /v1/threads`: a thread to send runs into with `threadId`. */
export function createThreadSnippet({ deploymentId, endpoints }: SubmitRunSnippetInput) {
  if (!PUBLIC_ID.test(deploymentId)) throw new TypeError("deploymentId must be a ULID.");
  return [
    `curl -sS -X POST "${endpoints.platformApi}/v1/threads" \\`,
    `  -H "authorization: Bearer $DEPLOYMENTS_API_KEY" \\`,
    `  -H "content-type: application/json" \\`,
    `  -d '{"agentDeploymentId": "${deploymentId}"}'`,
  ].join("\n");
}

/** A stream session, then an SSE read of the returned `streamUrl` with the session's token. */
export function streamThreadSnippet(endpoints: Pick<IntegrationEndpoints, "platformApi">) {
  return [
    `session=$(curl -sS -X POST "${endpoints.platformApi}/v1/threads/$THREAD_ID/stream-sessions" \\`,
    `  -H "authorization: Bearer $DEPLOYMENTS_API_KEY")`,
    `curl -N "$(echo "$session" | jq -r .streamUrl)?offset=-1&live=sse" \\`,
    `  -H "authorization: Bearer $(echo "$session" | jq -r .accessToken)"`,
  ].join("\n");
}
