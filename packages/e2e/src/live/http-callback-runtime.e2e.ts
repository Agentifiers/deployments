import { expect, it } from "@effect/vitest";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { CliProcess, CliProcessLive } from "../harness/cli-process.ts";
import { eventually } from "../harness/eventually.ts";
import {
  E2eHttpClient,
  fetchResendingGatewayThrottles,
  httpClientLayer,
  type E2eHttpClientService,
} from "../harness/http-client.ts";
import {
  acquireLiveAgent,
  cleanupHttpRequest,
  record,
  retryUnavailableHttpRequest,
  stringField,
} from "../harness/live-agent.ts";
import { json, records, version } from "../harness/response-records.ts";
import { callbackE2eConfig, credentialedE2eEnabled, e2eApiUrl } from "../harness/live-config.ts";
import { tenantHeaders } from "../harness/platform-credential.ts";
import { liveAgentModel } from "../harness/live-model.ts";

type JsonRecord = Record<string, unknown>;

const enabled = credentialedE2eEnabled();
const CALLBACK_PROVIDER_KEY = "extension_callback";
const CALLBACK_SCOPE = "callback:context:read";
const CALLBACK_ECHO_PREFIX = "E2E callback echo: ";

/** Reads the current version, then revokes or archives it; already-inactive resources are left alone. */
function cleanupVersioned(
  http: E2eHttpClientService,
  input: {
    readonly auth: Readonly<Record<string, string>>;
    readonly deletePath: string;
    readonly key: string;
    readonly label: string;
    readonly readPath: string;
  },
) {
  return http.request({ headers: input.auth, method: "GET", path: input.readPath }).pipe(
    Effect.flatMap((response) => {
      if (response.status === 404) return Effect.void;
      const current = json(response, 200, `${input.label} cleanup read`);
      if (current.status !== "active") return Effect.void;
      return cleanupHttpRequest(
        input.label,
        http.request({
          body: { expectedVersion: version(current, input.label), reason: "E2E cleanup" },
          headers: { ...input.auth, "idempotency-key": input.key },
          method: "DELETE",
          path: input.deletePath,
        }),
      );
    }),
    Effect.orDie,
  );
}

function callbackResult(call: JsonRecord, label: string) {
  const summary = call.outputSummary;
  if (typeof summary !== "string") throw new TypeError(`${label}.outputSummary was missing.`);
  try {
    return record(JSON.parse(summary), `${label}.outputSummary`);
  } catch (cause) {
    throw new Error(`${label}.outputSummary is not the fixture's intact JSON: ${summary}`, {
      cause,
    });
  }
}

it.effect.skipIf(!enabled)(
  "proves HTTP callback dispatch, workspace grants, policy allow, and secret rotation against the deployed fixture",
  () =>
    Effect.gen(function* () {
      const config = yield* callbackE2eConfig;
      const cli = yield* CliProcess;
      const http = yield* E2eHttpClient;
      const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
      const runKey = `e2e-callback-${randomUUID()}`;
      const marker = `callback-proof-${randomUUID()}`;
      const toolName = `e2e.callback.echo.${suffix}`;
      const auth = tenantHeaders(config.platformCredential, config);
      const endpoint = new URL(config.apiUrl);
      const execution = (endpointPath: string) => ({
        completionMode: "sync",
        endpointOrigin: endpoint.origin,
        endpointPath,
        type: "http_callback",
      });

      const workspace = yield* Effect.acquireRelease(
        http
          .request({
            body: {
              description: `HTTP callback workspace proof ${marker}`,
              name: `E2E callback ${suffix}`,
              slug: `e2e-callback-${suffix}`,
            },
            headers: { ...auth, "idempotency-key": `${runKey}:workspace` },
            method: "POST",
            path: "/v1/workspaces",
          })
          .pipe(Effect.map((response) => json(response, 201, "callback workspace create"))),
        (created) =>
          cleanupHttpRequest(
            "callback workspace",
            http.request({
              headers: { ...auth, "idempotency-key": `${runKey}:workspace:archive` },
              method: "DELETE",
              path: `/v1/workspaces/${stringField(created, "id", "callback workspace")}`,
            }),
          ).pipe(Effect.orDie),
      );
      const workspaceId = stringField(workspace, "id", "callback workspace");

      const connection = yield* Effect.acquireRelease(
        http
          .request({
            body: {
              displayName: `E2E callbacks ${suffix}`,
              providerKey: CALLBACK_PROVIDER_KEY,
            },
            headers: { ...auth, "idempotency-key": `${runKey}:connection` },
            method: "POST",
            path: "/v1/credentials",
          })
          .pipe(Effect.map((response) => json(response, 201, "callback connection create"))),
        (created) => {
          const id = stringField(created, "id", "callback connection");
          return cleanupVersioned(http, {
            auth,
            deletePath: `/v1/credentials/${id}`,
            key: `${runKey}:connection:revoke`,
            label: "callback connection",
            readPath: `/v1/connections/${id}`,
          });
        },
      );
      const connectionId = stringField(connection, "id", "callback connection");
      expect(connection).toMatchObject({
        hasCredential: false,
        providerKey: CALLBACK_PROVIDER_KEY,
        scopes: expect.arrayContaining([CALLBACK_SCOPE]),
        status: "active",
      });

      const extension = yield* Effect.acquireRelease(
        http
          .request({
            body: {
              callbackSecret: config.callbackInitialSecret,
              defaultPolicyAction: "deny",
              description: `Deployed HTTP callback echo proof ${suffix}`,
              effect: "read",
              execution: execution("/_e2e/callback/initial"),
              inputSchema: {
                additionalProperties: false,
                properties: { marker: { type: "string" } },
                required: ["marker"],
                type: "object",
              },
              name: toolName,
              providerKey: CALLBACK_PROVIDER_KEY,
              requiredScopes: [CALLBACK_SCOPE],
            },
            headers: { ...auth, "idempotency-key": `${runKey}:extension` },
            method: "POST",
            path: "/v1/extensions",
          })
          .pipe(Effect.map((response) => json(response, 201, "callback extension create"))),
        () =>
          cleanupVersioned(http, {
            auth,
            deletePath: `/v1/extensions/${encodeURIComponent(toolName)}`,
            key: `${runKey}:extension:archive`,
            label: "callback extension",
            readPath: `/v1/extensions/${encodeURIComponent(toolName)}`,
          }),
      );
      const extensionId = stringField(extension, "id", "callback extension");
      expect(extension).toMatchObject({
        defaultPolicyAction: "deny",
        effect: "read",
        execution: execution("/_e2e/callback/initial"),
        hasCallbackAuth: true,
        name: toolName,
        providerKey: CALLBACK_PROVIDER_KEY,
        requiredScopes: [CALLBACK_SCOPE],
        status: "active",
      });
      expect(JSON.stringify(extension)).not.toContain(config.callbackInitialSecret);

      const policy = yield* Effect.acquireRelease(
        http
          .request({
            body: {
              description: `Allows only the ${toolName} callback proof.`,
              name: `E2E callback policy ${suffix}`,
              policy: {
                rules: [
                  {
                    action: "allow",
                    effect: "read",
                    providerKey: CALLBACK_PROVIDER_KEY,
                    reason: "E2E callback proof policy allows the fixture echo.",
                    requiredScopes: [CALLBACK_SCOPE],
                    toolName,
                  },
                ],
              },
            },
            headers: { ...auth, "idempotency-key": `${runKey}:policy` },
            method: "POST",
            path: "/v1/tool-policies",
          })
          .pipe(Effect.map((response) => json(response, 201, "callback policy create"))),
        (created) => {
          const id = stringField(created, "id", "callback policy");
          return cleanupVersioned(http, {
            auth,
            deletePath: `/v1/tool-policies/${id}`,
            key: `${runKey}:policy:archive`,
            label: "callback policy",
            readPath: `/v1/tool-policies/${id}`,
          });
        },
      );
      const toolPolicyId = stringField(policy, "id", "callback policy");

      const grant = yield* Effect.acquireRelease(
        http
          .request({
            body: {
              connectionId,
              externalResourceConstraints: { marker },
              purpose: "agent-runtime",
              scopes: [CALLBACK_SCOPE],
              workspaceId,
            },
            headers: { ...auth, "idempotency-key": `${runKey}:grant` },
            method: "POST",
            path: "/v1/connection-grants",
          })
          .pipe(Effect.map((response) => json(response, 201, "callback grant create"))),
        (created) => {
          const id = stringField(created, "id", "callback grant");
          return cleanupVersioned(http, {
            auth,
            deletePath: `/v1/connection-grants/${id}`,
            key: `${runKey}:grant:revoke`,
            label: "callback grant",
            readPath: `/v1/connection-grants/${id}`,
          });
        },
      );
      const authorizationId = stringField(grant, "id", "callback grant");
      expect(grant).toMatchObject({
        connectionId,
        providerKey: CALLBACK_PROVIDER_KEY,
        scopes: [CALLBACK_SCOPE],
        status: "active",
        workspaceId,
      });

      const manifest = {
        apiVersion: "agents.deployments.ai/v1",
        kind: "Agent",
        metadata: { key: runKey, name: `E2E callback agent ${suffix}`, version: "1.0.0" },
        spec: {
          capabilities: {
            tools: [
              {
                authorization: "workspace",
                name: toolName,
                required: true,
                requiredScopes: [CALLBACK_SCOPE],
              },
            ],
          },
          instructions:
            "After the callback tool returns, reply with only the exact `echo` string from its JSON result and nothing else.",
          model: liveAgentModel.model,
          runtime: {
            ...liveAgentModel.runtime,
            toolRequests: [
              {
                effect: "read",
                idempotencyKey: `${runKey}:tool-call`,
                input: { marker },
                inputSummary: "Echo the deployed HTTP callback marker.",
                requiredScopes: [CALLBACK_SCOPE],
                toolName,
              },
            ],
          },
          sandbox: { mode: "none" },
          triggers: ["api"],
        },
      };
      const runtimeConfig = {
        apiVersion: "agents.deployments.ai/v1",
        kind: "AgentDeploymentConfig",
        toolAuthorizations: { [toolName]: { authorizationId, toolPolicyId } },
      };
      const agent = yield* acquireLiveAgent(cli, config, runKey, manifest, { runtimeConfig });
      const runtimeAuth = tenantHeaders(agent.runtimeApiKey, config);

      const proveRun = (label: string) =>
        Effect.gen(function* () {
          const submitted = json(
            yield* retryUnavailableHttpRequest(
              `${label} run submit`,
              http.request({
                body: {
                  content: "Run the configured callback proof and report its echo value.",
                  title: `Callback proof ${label} ${suffix}`,
                  workspaceId,
                },
                headers: { ...runtimeAuth, "idempotency-key": `${runKey}:run:${label}` },
                method: "POST",
                path: `/v1/agent-deployments/${agent.deploymentId}/runs`,
                timeoutMs: 60_000,
              }),
            ),
            202,
            `${label} run submit`,
          );
          const runId = stringField(record(submitted.run, `${label} run`), "id", `${label} run`);
          const threadId = stringField(
            record(submitted.thread, `${label} thread`),
            "id",
            `${label} thread`,
          );
          yield* eventually(
            { label: `completed ${label} callback run ${runId}`, timeoutMs: 240_000 },
            http
              .request({
                headers: runtimeAuth,
                method: "GET",
                path: `/v1/threads/${threadId}/runs/${runId}`,
              })
              .pipe(
                Effect.map((response) => {
                  const current = json(response, 200, `${label} run get`);
                  if (current.status === "failed") {
                    throw new Error(`${label} callback run failed: ${response.body}`);
                  }
                  return current.status === "completed" ? current : undefined;
                }),
              ),
          );

          const calls = records(
            json(
              yield* http.request({
                headers: runtimeAuth,
                method: "GET",
                path: `/v1/runs/${runId}/tool-calls`,
              }),
              200,
              `${label} tool calls`,
            ).toolCalls,
            `${label} tool calls.toolCalls`,
          ).filter((call) => call.toolName === toolName);
          expect(calls).toHaveLength(1);
          expect(calls[0]).toMatchObject({
            policyAction: "allow",
            status: "succeeded",
            toolAdapterId: extensionId,
            toolName,
          });
          // The model sees the redacted outputSummary; it must still be the fixture's intact JSON.
          const result = callbackResult(calls[0]!, `${label} tool call`);

          const messages = records(
            json(
              yield* http.request({
                headers: runtimeAuth,
                method: "GET",
                path: `/v1/threads/${threadId}/messages`,
              }),
              200,
              `${label} messages`,
            ).messages,
            `${label} messages.messages`,
          );
          const assistantBodies = messages
            .filter((message) => message.role === "assistant" && message.runId === runId)
            .map((message) => message.body);
          expect(
            assistantBodies.some((body) => typeof body === "string" && body.includes(marker)),
            `${label} assistant reply must contain the callback marker: ${JSON.stringify(assistantBodies)}`,
          ).toBe(true);
          return result;
        });

      expect(yield* proveRun("initial")).toEqual({
        authenticatedAs: "initial",
        echo: `${CALLBACK_ECHO_PREFIX}${marker}`,
        idempotencyKey: expect.stringMatching(/^dai-[0-9a-f]{46}$/u),
        marker,
        toolCallId: expect.any(String),
        toolName,
      });

      const rotated = json(
        yield* http.request({
          body: {
            callbackSecret: config.callbackRotatedSecret,
            execution: execution("/_e2e/callback/rotated"),
            expectedVersion: version(extension, "callback extension"),
          },
          headers: { ...auth, "idempotency-key": `${runKey}:extension:rotate` },
          method: "PATCH",
          path: `/v1/extensions/${encodeURIComponent(toolName)}`,
        }),
        200,
        "callback extension rotate",
      );
      expect(rotated).toMatchObject({
        execution: execution("/_e2e/callback/rotated"),
        hasCallbackAuth: true,
        id: extensionId,
        version: version(extension, "callback extension") + 1,
      });
      expect(JSON.stringify(rotated)).not.toContain(config.callbackRotatedSecret);

      const rejectedOldSecret = yield* Effect.tryPromise({
        try: () =>
          fetchResendingGatewayThrottles(new URL("/_e2e/callback/rotated", endpoint), {
            body: JSON.stringify({
              idempotencyKey: `${runKey}:direct`,
              input: { marker },
              toolCallId: `${runKey}:direct`,
              toolName,
              version: 1,
            }),
            headers: {
              authorization: `Bearer ${config.callbackInitialSecret}`,
              "content-type": "application/json",
            },
            method: "POST",
          }),
        catch: (cause) => new Error("Rotated callback fixture credential check failed.", { cause }),
      });
      expect(rejectedOldSecret.status).toBe(401);

      expect(yield* proveRun("rotated")).toMatchObject({
        authenticatedAs: "rotated",
        echo: `${CALLBACK_ECHO_PREFIX}${marker}`,
        marker,
        toolName,
      });
    }).pipe(Effect.provide(CliProcessLive), Effect.provide(httpClientLayer(e2eApiUrl()))),
  900_000,
);
