import { expect, it } from "@effect/vitest";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { CliProcess, CliProcessLive } from "../harness/cli-process.ts";
import { eventually } from "../harness/eventually.ts";
import {
  E2eHttpClient,
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
import { json, records } from "../harness/response-records.ts";
import { tenantHeaders } from "../harness/platform-credential.ts";
import {
  providerOAuthE2eConfig,
  providerOAuthE2eEnabled,
} from "../harness/third-party-live-config.ts";
import { e2eApiUrl } from "../harness/live-config.ts";
import { liveAgentModel } from "../harness/live-model.ts";

type JsonRecord = Record<string, unknown>;

const enabled = providerOAuthE2eEnabled();
// GitHub's hosted MCP server; the reviewed PRM `resource` is the canonical endpoint itself.
const MCP_RESOURCE = "https://api.githubcopilot.com/mcp/";
const REMOTE_TOOL_NAME = "get_me";
// Synced platform name: `<providerKey>.<normalized remote name>` (vendorMcpToolName).
const TOOL_NAME = "github.get_me";
// Classified vendor MCP reads require only the read capability scope.
const TOOL_SCOPES = ["tools:read"] as const;
const CAPABILITY_SCOPES = ["tools:read", "tools:write"] as const;

/** Revokes a versioned administration resource unless it already reached its terminal status. */
function cleanupVersioned(
  http: E2eHttpClientService,
  input: {
    readonly auth: Readonly<Record<string, string>>;
    readonly id: string;
    readonly key: string;
    readonly label: string;
    readonly path: string;
    readonly terminalStatus: string;
  },
) {
  return http
    .request({ headers: input.auth, method: "GET", path: `${input.path}/${input.id}` })
    .pipe(
      Effect.flatMap((response) => {
        if (response.status === 404) return Effect.void;
        const current = json(response, 200, `${input.label} cleanup read`);
        if (current.status === input.terminalStatus) return Effect.void;
        if (!Number.isSafeInteger(current.version)) {
          return Effect.die(new TypeError(`${input.label}.version was invalid.`));
        }
        return cleanupHttpRequest(
          input.label,
          http.request({
            body: { expectedVersion: current.version, reason: "E2E cleanup" },
            headers: { ...input.auth, "idempotency-key": input.key },
            method: "DELETE",
            path: `${input.path}/${input.id}`,
          }),
        );
      }),
      Effect.orDie,
    );
}

/** Finds the connection the public OAuth callback created for this authorization attempt. */
function authorizedConnection(
  http: E2eHttpClientService,
  auth: Readonly<Record<string, string>>,
  applicationId: string,
  startedAtMs: number,
) {
  return Effect.gen(function* () {
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({ limit: "100", ...(cursor ? { cursor } : {}) });
      const page = json(
        yield* retryUnavailableHttpRequest(
          "GitHub connection list",
          http.request({
            headers: auth,
            method: "GET",
            path: `/v1/connections?${query.toString()}`,
          }),
        ),
        200,
        "GitHub connection list",
      );
      const match = records(page.items, "GitHub connection list.items").find(
        (connection) =>
          connection.providerApplicationId === applicationId &&
          connection.providerKey === "github" &&
          connection.status === "active" &&
          typeof connection.createdAt === "string" &&
          Date.parse(connection.createdAt) >= startedAtMs,
      );
      if (match) return match;
      cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
    } while (cursor);
    return undefined;
  });
}

it.effect.skipIf(!enabled)(
  "proves operator-completed GitHub MCP OAuth, tool sync, deployed vendor MCP read, and revocation",
  () =>
    Effect.gen(function* () {
      const config = yield* providerOAuthE2eConfig;
      const cli = yield* CliProcess;
      const http = yield* E2eHttpClient;
      const runKey = `e2e-provider-oauth-${randomUUID()}`;
      const auth = tenantHeaders(config.platformCredential, config);

      const application = json(
        yield* retryUnavailableHttpRequest(
          "GitHub provider application read",
          http.request({
            headers: auth,
            method: "GET",
            path: `/v1/oauth-apps/${config.githubOAuthApplicationId}`,
          }),
        ),
        200,
        "GitHub provider application read",
      );
      expect(application).toMatchObject({
        hasClientSecret: true,
        id: config.githubOAuthApplicationId,
        providerKey: "github",
        status: "active",
      });

      const workspace = yield* Effect.acquireRelease(
        http
          .request({
            body: {
              description: `Provider OAuth proof ${runKey}`,
              name: `E2E OAuth ${runKey}`,
              slug: `e2e-oauth-${randomUUID().replaceAll("-", "").slice(0, 20)}`,
            },
            headers: { ...auth, "idempotency-key": `${runKey}:workspace` },
            method: "POST",
            path: "/v1/workspaces",
          })
          .pipe(Effect.map((response) => json(response, 201, "OAuth workspace create"))),
        (created) =>
          cleanupHttpRequest(
            "OAuth workspace",
            http.request({
              headers: { ...auth, "idempotency-key": `${runKey}:workspace:archive` },
              method: "DELETE",
              path: `/v1/workspaces/${stringField(created, "id", "OAuth workspace")}`,
            }),
          ).pipe(Effect.orDie),
      );
      const workspaceId = stringField(workspace, "id", "OAuth workspace");

      const startedAtMs = Date.now() - 5_000;
      const attempt = json(
        yield* http.request({
          body: { providerApplicationId: config.githubOAuthApplicationId, providerKey: "github" },
          headers: { ...auth, "idempotency-key": `${runKey}:authorize` },
          method: "POST",
          path: "/v1/connections",
        }),
        201,
        "GitHub authorization begin",
      );
      const authorizationUrl = new URL(stringField(attempt, "authorizationUrl", "GitHub attempt"));
      expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
        "https://github.com/login/oauth/authorize",
      );
      expect(authorizationUrl.searchParams.get("client_id")).toBe(application.clientId);
      expect(application.redirectUris).toContain(authorizationUrl.searchParams.get("redirect_uri"));
      expect(authorizationUrl.searchParams.get("redirect_uri")).toMatch(
        /\/public\/provider-connections\/oauth\/callback\/github$/u,
      );
      expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authorizationUrl.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      // RFC 8707: the token is audience-bound to the pinned GitHub MCP protected resource.
      expect(authorizationUrl.searchParams.get("resource")).toBe(MCP_RESOURCE);
      expect(authorizationUrl.searchParams.get("scope")?.split(" ")).toEqual(
        expect.arrayContaining(["read:user", "repo"]),
      );
      expect(authorizationUrl.searchParams.get("state")).toMatch(
        new RegExp(
          `^${config.organizationId}\\.${config.projectId}\\.${config.environmentId}\\.[0-9A-HJKMNP-TV-Z]{26}\\.`,
          "u",
        ),
      );
      // The state-bound code can only be produced by a person granting consent, so the operator
      // opens this one-time URL; the deployed public callback exchanges the code server-side.
      console.info(
        [
          "Provider OAuth E2E is waiting for GitHub consent.",
          `Open within ${String(config.providerOAuthAuthorizationTimeoutMs / 1_000)} seconds as the sandbox GitHub user:`,
          authorizationUrl.href,
        ].join("\n"),
      );

      const connection = yield* Effect.acquireRelease(
        eventually(
          {
            intervalMs: 5_000,
            label: "operator-completed GitHub OAuth authorization",
            timeoutMs: config.providerOAuthAuthorizationTimeoutMs,
          },
          authorizedConnection(http, auth, config.githubOAuthApplicationId, startedAtMs),
        ),
        (created) =>
          cleanupVersioned(http, {
            auth,
            id: stringField(created, "id", "GitHub connection"),
            key: `${runKey}:connection:revoke`,
            label: "GitHub connection",
            path: "/v1/connections",
            terminalStatus: "disconnected",
          }),
      );
      const connectionId = stringField(connection, "id", "GitHub connection");
      expect(connection).toMatchObject({
        authMethod: "oauth",
        hasCredential: true,
        providerApplicationId: config.githubOAuthApplicationId,
        scopes: expect.arrayContaining([...CAPABILITY_SCOPES]),
        status: "active",
      });

      const verification = json(
        yield* http.request({
          headers: { ...auth, "idempotency-key": `${runKey}:verify` },
          method: "POST",
          path: `/v1/connections/${connectionId}/verify`,
          timeoutMs: 60_000,
        }),
        202,
        "GitHub connection verification",
      );
      // mcp_discovery verification initializes the MCP session with the stored token and lists tools.
      expect(verification).toMatchObject({
        connectionId,
        providerKey: "github",
        result: {
          method: "mcp_discovery",
          scopes: [...CAPABILITY_SCOPES],
          toolCount: expect.any(Number),
        },
        status: "verified",
      });

      const synced = json(
        yield* http.request({
          headers: { ...auth, "idempotency-key": `${runKey}:tools-sync` },
          method: "POST",
          path: `/v1/connections/${connectionId}/tools/sync`,
          timeoutMs: 60_000,
        }),
        200,
        "GitHub MCP tool sync",
      );
      expect(synced).toMatchObject({ connectionId, providerKey: "github" });
      // A rerun reconciles the same environment adapter, so any non-rejecting change is valid.
      expect(records(synced.tools, "GitHub MCP tool sync.tools")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            change: expect.stringMatching(/^(?:created|unchanged|updated)$/u),
            classified: true,
            destructive: false,
            effect: "read",
            remoteName: REMOTE_TOOL_NAME,
            toolName: TOOL_NAME,
          }),
        ]),
      );
      const adapter = json(
        yield* http.request({
          headers: auth,
          method: "GET",
          path: `/v1/extensions/${encodeURIComponent(TOOL_NAME)}`,
        }),
        200,
        "GitHub MCP tool adapter read",
      );
      expect(adapter).toMatchObject({
        defaultPolicyAction: "allow",
        effect: "read",
        execution: {
          providerKey: "github",
          remoteToolName: REMOTE_TOOL_NAME,
          toolHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
          type: "vendor_mcp",
        },
        name: TOOL_NAME,
        providerKey: "github",
        requiredScopes: [...TOOL_SCOPES],
        status: "active",
      });
      const toolAdapterId = stringField(adapter, "id", "GitHub MCP tool adapter");

      const grant = yield* Effect.acquireRelease(
        http
          .request({
            body: {
              connectionId,
              purpose: "agent-runtime",
              scopes: TOOL_SCOPES,
              workspaceId,
            },
            headers: { ...auth, "idempotency-key": `${runKey}:grant` },
            method: "POST",
            path: "/v1/connection-grants",
          })
          .pipe(Effect.map((response) => json(response, 201, "GitHub grant create"))),
        (created) =>
          cleanupVersioned(http, {
            auth,
            id: stringField(created, "id", "GitHub grant"),
            key: `${runKey}:grant:revoke`,
            label: "GitHub grant",
            path: "/v1/connection-grants",
            terminalStatus: "revoked",
          }),
      );
      const authorizationId = stringField(grant, "id", "GitHub grant");
      expect(grant).toMatchObject({
        connectionId,
        providerKey: "github",
        scopes: [...TOOL_SCOPES],
        status: "active",
        workspaceId,
      });

      const manifest = {
        apiVersion: "agents.deployments.ai/v1",
        kind: "Agent",
        metadata: { key: runKey, name: `E2E OAuth agent ${runKey}`, version: "1.0.0" },
        spec: {
          capabilities: {
            tools: [
              {
                authorization: "workspace",
                name: TOOL_NAME,
                required: true,
                requiredScopes: TOOL_SCOPES,
              },
            ],
          },
          instructions: "Confirm the authenticated GitHub user's login in one short sentence.",
          model: liveAgentModel.model,
          runtime: {
            ...liveAgentModel.runtime,
            toolRequests: [
              {
                effect: "read",
                idempotencyKey: `${runKey}:tool-call`,
                input: {},
                inputSummary: "Read the authenticated GitHub user through GitHub MCP",
                requiredScopes: TOOL_SCOPES,
                toolName: TOOL_NAME,
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
        toolAuthorizations: { [TOOL_NAME]: { authorizationId } },
      };
      const agent = yield* acquireLiveAgent(cli, config, runKey, manifest, { runtimeConfig });
      const runtimeAuth = tenantHeaders(agent.runtimeApiKey, config);
      const submitted = json(
        yield* retryUnavailableHttpRequest(
          "GitHub run submit",
          http.request({
            body: {
              content: "Read the authenticated GitHub user through the granted GitHub connection.",
              title: `GitHub OAuth proof ${runKey}`,
              workspaceId,
            },
            headers: { ...runtimeAuth, "idempotency-key": `${runKey}:run` },
            method: "POST",
            path: `/v1/agent-deployments/${agent.deploymentId}/runs`,
            timeoutMs: 60_000,
          }),
        ),
        202,
        "GitHub run submit",
      );
      const runId = stringField(record(submitted.run, "GitHub run"), "id", "GitHub run");
      const threadId = stringField(
        record(submitted.thread, "GitHub thread"),
        "id",
        "GitHub thread",
      );
      yield* eventually(
        { label: `completed GitHub run ${runId}`, timeoutMs: 240_000 },
        http
          .request({
            headers: runtimeAuth,
            method: "GET",
            path: `/v1/threads/${threadId}/runs/${runId}`,
          })
          .pipe(
            Effect.map((response) => {
              const current = json(response, 200, "GitHub run get");
              if (current.status === "failed") {
                throw new Error(`GitHub run failed: ${response.body}`);
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
          "GitHub tool calls",
        ).toolCalls,
        "GitHub tool calls.toolCalls",
      );
      // The vendor MCP binding re-lists tools, checks the pinned hash, and calls `get_me` with the
      // granted connection's token; a tool-level MCP error would still complete the call.
      expect(calls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            outputSummary: expect.not.stringContaining("reported an error"),
            policyAction: "allow",
            status: "succeeded",
            toolAdapterId,
            toolName: TOOL_NAME,
          }),
        ]),
      );

      const current: JsonRecord = json(
        yield* http.request({
          headers: auth,
          method: "GET",
          path: `/v1/connections/${connectionId}`,
        }),
        200,
        "GitHub connection read",
      );
      const revoked = json(
        yield* http.request({
          body: { expectedVersion: current.version, reason: "E2E revocation proof" },
          headers: { ...auth, "idempotency-key": `${runKey}:connection:revoke` },
          method: "DELETE",
          path: `/v1/connections/${connectionId}`,
        }),
        200,
        "GitHub connection revoke",
      );
      expect(revoked).toMatchObject({ id: connectionId, status: "disconnected" });
      expect(
        json(
          yield* http.request({
            headers: auth,
            method: "GET",
            path: `/v1/connection-grants/${authorizationId}`,
          }),
          200,
          "GitHub grant read after revocation",
        ),
      ).toMatchObject({ id: authorizationId, status: "revoked" });
    }).pipe(Effect.provide(CliProcessLive), Effect.provide(httpClientLayer(e2eApiUrl()))),
  900_000,
);
