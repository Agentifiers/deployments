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
import { credentialedE2eEnabled, e2eApiUrl, mcpE2eConfig } from "../harness/live-config.ts";
import { tenantHeaders } from "../harness/platform-credential.ts";
import { liveAgentModel } from "../harness/live-model.ts";

const enabled = credentialedE2eEnabled();
const REMOTE_TOOL_NAME = "e2e-echo";

function cleanupVersioned(
  http: E2eHttpClientService,
  input: {
    readonly auth: Readonly<Record<string, string>>;
    readonly id: string;
    readonly key: string;
    readonly label: string;
    readonly path: string;
  },
) {
  return http
    .request({ headers: input.auth, method: "GET", path: `${input.path}/${input.id}` })
    .pipe(
      Effect.flatMap((response) => {
        if (response.status === 404) return Effect.void;
        const current = json(response, 200, `${input.label} cleanup read`);
        return cleanupHttpRequest(
          input.label,
          http.request({
            body: { expectedVersion: version(current, input.label), reason: "E2E cleanup" },
            headers: { ...input.auth, "idempotency-key": input.key },
            method: "DELETE",
            path: `${input.path}/${input.id}`,
          }),
        );
      }),
      Effect.orDie,
    );
}

it.effect.skipIf(!enabled)(
  "proves remote MCP discovery, credential rotation, workspace authorization, and deployed execution",
  () =>
    Effect.gen(function* () {
      const config = yield* mcpE2eConfig;
      const cli = yield* CliProcess;
      const http = yield* E2eHttpClient;
      const runKey = `e2e-mcp-${randomUUID()}`;
      const marker = `mcp-proof-${randomUUID()}`;
      const toolName = `e2e.remote.echo.${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      const auth = tenantHeaders(config.platformCredential, config);
      const endpoint = new URL(config.apiUrl);

      const workspace = yield* Effect.acquireRelease(
        http
          .request({
            body: {
              description: `MCP workspace proof ${marker}`,
              name: `E2E MCP ${marker}`,
              slug: `e2e-mcp-${randomUUID().replaceAll("-", "").slice(0, 20)}`,
            },
            headers: { ...auth, "idempotency-key": `${runKey}:workspace` },
            method: "POST",
            path: "/v1/workspaces",
          })
          .pipe(Effect.map((response) => json(response, 201, "MCP workspace create"))),
        (created) =>
          cleanupHttpRequest(
            "MCP workspace",
            http.request({
              headers: { ...auth, "idempotency-key": `${runKey}:workspace:archive` },
              method: "DELETE",
              path: `/v1/workspaces/${stringField(created, "id", "MCP workspace")}`,
            }),
          ).pipe(Effect.orDie),
      );
      const workspaceId = stringField(workspace, "id", "MCP workspace");

      const server = yield* Effect.acquireRelease(
        http
          .request({
            body: {
              auth: { bearerToken: config.mcpInitialToken },
              endpointOrigin: endpoint.origin,
              endpointPath: "/_e2e/mcp/initial",
              name: `E2E MCP server ${marker}`,
              toolAllowlist: [REMOTE_TOOL_NAME],
            },
            headers: { ...auth, "idempotency-key": `${runKey}:server` },
            method: "POST",
            path: "/v1/mcp-servers",
          })
          .pipe(Effect.map((response) => json(response, 201, "MCP server create"))),
        (created) =>
          cleanupVersioned(http, {
            auth,
            id: stringField(created, "id", "MCP server"),
            key: `${runKey}:server:archive`,
            label: "MCP server",
            path: "/v1/mcp-servers",
          }),
      );
      const serverId = stringField(server, "id", "MCP server");
      expect(server).toMatchObject({ hasAuth: true, status: "active", version: 0 });

      const discovered = json(
        yield* retryUnavailableHttpRequest(
          "MCP discovery",
          http.request({
            headers: { ...auth, "idempotency-key": `${runKey}:discover` },
            method: "POST",
            path: `/v1/mcp-servers/${serverId}/discover`,
            timeoutMs: 60_000,
          }),
        ),
        200,
        "MCP discovery",
      );
      expect(discovered).toMatchObject({
        serverId,
        tools: [
          {
            inputSchema: expect.objectContaining({ type: "object" }),
            remoteName: REMOTE_TOOL_NAME,
          },
        ],
      });

      const rotatedServer = json(
        yield* http.request({
          body: {
            auth: { bearerToken: config.mcpRotatedToken },
            endpointPath: "/_e2e/mcp/rotated",
            expectedVersion: version(server, "MCP server"),
            name: `E2E MCP rotated ${marker}`,
          },
          headers: { ...auth, "idempotency-key": `${runKey}:server:update` },
          method: "PATCH",
          path: `/v1/mcp-servers/${serverId}`,
        }),
        200,
        "MCP server update",
      );
      expect(rotatedServer).toMatchObject({ hasAuth: true, id: serverId, version: 1 });

      const rejectedOldCredential = yield* Effect.tryPromise({
        try: () =>
          fetchResendingGatewayThrottles(new URL("/_e2e/mcp/rotated", endpoint), {
            body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "initialize", params: {} }),
            headers: {
              authorization: `Bearer ${config.mcpInitialToken}`,
              "content-type": "application/json",
            },
            method: "POST",
          }),
        catch: (cause) => new Error("Rotated MCP fixture credential check failed.", { cause }),
      });
      expect(rejectedOldCredential.status).toBe(401);
      const rotatedDiscovery = json(
        yield* http.request({
          headers: { ...auth, "idempotency-key": `${runKey}:discover:rotated` },
          method: "POST",
          path: `/v1/mcp-servers/${serverId}/discover`,
          timeoutMs: 60_000,
        }),
        200,
        "rotated MCP discovery",
      );
      expect(rotatedDiscovery.tools).toEqual(discovered.tools);

      const extension = yield* Effect.acquireRelease(
        http
          .request({
            body: {
              defaultPolicyAction: "allow",
              description: `Deployed MCP echo proof ${marker}`,
              effect: "read",
              execution: {
                mcpServerId: serverId,
                remoteToolName: REMOTE_TOOL_NAME,
                type: "mcp",
              },
              inputSchema: {
                additionalProperties: false,
                properties: { marker: { type: "string" } },
                required: ["marker"],
                type: "object",
              },
              name: toolName,
              requiredScopes: [toolName],
            },
            headers: { ...auth, "idempotency-key": `${runKey}:extension` },
            method: "POST",
            path: "/v1/extensions",
          })
          .pipe(Effect.map((response) => json(response, 201, "MCP extension create"))),
        () =>
          cleanupVersioned(http, {
            auth,
            id: encodeURIComponent(toolName),
            key: `${runKey}:extension:archive`,
            label: "MCP extension",
            path: "/v1/extensions",
          }),
      );
      const extensionId = stringField(extension, "id", "MCP extension");
      expect(extension).toMatchObject({
        defaultPolicyAction: "allow",
        effect: "read",
        hasCallbackAuth: false,
        name: toolName,
        status: "active",
      });

      const connection = yield* Effect.acquireRelease(
        http
          .request({
            body: { mcpServerId: serverId },
            headers: { ...auth, "idempotency-key": `${runKey}:connection` },
            method: "POST",
            path: "/v1/mcp-connections",
          })
          .pipe(Effect.map((response) => json(response, 201, "MCP connection create"))),
        (created) =>
          cleanupVersioned(http, {
            auth,
            id: stringField(created, "id", "MCP connection"),
            key: `${runKey}:connection:revoke`,
            label: "MCP connection",
            path: "/v1/mcp-connections",
          }),
      );
      const connectionId = stringField(connection, "id", "MCP connection");
      expect(connection).toMatchObject({ mcpServerId: serverId, status: "active" });

      const grant = yield* Effect.acquireRelease(
        http
          .request({
            body: {
              connectionId,
              externalResourceConstraints: { marker },
              purpose: "agent-runtime",
              scopes: [toolName],
              workspaceId,
            },
            headers: { ...auth, "idempotency-key": `${runKey}:grant` },
            method: "POST",
            path: "/v1/connection-grants",
          })
          .pipe(Effect.map((response) => json(response, 201, "MCP grant create"))),
        (created) =>
          cleanupVersioned(http, {
            auth,
            id: stringField(created, "id", "MCP grant"),
            key: `${runKey}:grant:revoke`,
            label: "MCP grant",
            path: "/v1/connection-grants",
          }),
      );
      const authorizationId = stringField(grant, "id", "MCP grant");
      expect(grant).toMatchObject({
        connectionId,
        externalAccountId: serverId,
        providerKey: "mcp",
        scopes: [toolName],
        status: "active",
        workspaceId,
      });

      const manifest = {
        apiVersion: "agents.deployments.ai/v1",
        kind: "Agent",
        metadata: { key: runKey, name: `E2E MCP agent ${runKey}`, version: "1.0.0" },
        spec: {
          capabilities: {
            tools: [
              {
                authorization: "workspace",
                name: toolName,
                required: true,
                requiredScopes: [toolName],
              },
            ],
          },
          instructions: "Confirm the release-pinned MCP result in one short sentence.",
          model: liveAgentModel.model,
          runtime: {
            ...liveAgentModel.runtime,
            toolRequests: [
              {
                effect: "read",
                idempotencyKey: `${runKey}:tool-call`,
                input: { marker },
                inputSummary: `Echo deployed MCP marker ${marker}`,
                requiredScopes: [toolName],
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
        toolAuthorizations: { [toolName]: { authorizationId } },
      };
      const agent = yield* acquireLiveAgent(cli, config, runKey, manifest, { runtimeConfig });
      const runtimeAuth = tenantHeaders(agent.runtimeApiKey, config);
      const submitted = json(
        yield* retryUnavailableHttpRequest(
          "MCP run submit",
          http.request({
            body: {
              content: `Execute the configured MCP proof for ${marker}.`,
              title: `MCP proof ${runKey}`,
              workspaceId,
            },
            headers: { ...runtimeAuth, "idempotency-key": `${runKey}:run` },
            method: "POST",
            path: `/v1/agent-deployments/${agent.deploymentId}/runs`,
            timeoutMs: 60_000,
          }),
        ),
        202,
        "MCP run submit",
      );
      const run = record(submitted.run, "MCP submitted run");
      const runId = stringField(run, "id", "MCP submitted run");
      const threadId = stringField(record(submitted.thread, "MCP thread"), "id", "MCP thread");

      yield* eventually(
        { label: `completed MCP run ${runId}`, timeoutMs: 240_000 },
        http
          .request({
            headers: runtimeAuth,
            method: "GET",
            path: `/v1/threads/${threadId}/runs/${runId}`,
          })
          .pipe(
            Effect.map((response) => {
              const current = json(response, 200, "MCP run get");
              if (current.status === "failed") {
                throw new Error(`MCP run failed: ${response.body}`);
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
          "MCP tool calls",
        ).toolCalls,
        "MCP tool calls.toolCalls",
      );
      expect(calls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            outputSummary: expect.stringContaining(marker),
            policyAction: "allow",
            status: "succeeded",
            toolAdapterId: extensionId,
            toolName,
          }),
        ]),
      );

      const artifacts = records(
        json(
          yield* http.request({
            headers: runtimeAuth,
            method: "GET",
            path: `/v1/artifacts?runId=${runId}`,
          }),
          200,
          "MCP artifacts",
        ).artifacts,
        "MCP artifacts.artifacts",
      );
      expect(artifacts).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            metadata: expect.objectContaining({
              source: expect.objectContaining({ source: "mcp.remote" }),
            }),
          }),
        ]),
      );
    }).pipe(Effect.provide(CliProcessLive), Effect.provide(httpClientLayer(e2eApiUrl()))),
  600_000,
);
