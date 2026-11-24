import { expect, it } from "@effect/vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
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
import { credentialedE2eEnabled, e2eApiUrl, scopedE2eConfig } from "../harness/live-config.ts";
import { tenantHeaders } from "../harness/platform-credential.ts";
import { liveAgentModel } from "../harness/live-model.ts";

type JsonRecord = Record<string, unknown>;
type Auth = Readonly<Record<string, string>>;

const enabled = credentialedE2eEnabled();
const SECRET_NAME = "E2E_HOSTED_TOOL_SECRET";

const JAVASCRIPT_SOURCE = `export async function handler(input) {
  return { echo: input.marker, sum: input.a + input.b };
}
`;

const PYTHON_SOURCE = `import hashlib
import os


def handler(input):
    secret = os.environ["${SECRET_NAME}"]
    return {
        "echo": input["marker"],
        "secretLength": len(secret),
        "secretSha256Prefix": hashlib.sha256(secret.encode("utf-8")).hexdigest()[:12],
    }
`;

const NETWORK_PROBE_SOURCE = `export async function handler() {
  try {
    await fetch("https://deployments.ai/", { signal: AbortSignal.timeout(5000) });
    return { blocked: false };
  } catch (error) {
    return { blocked: true, reason: String(error && error.name ? error.name : error) };
  }
}
`;

function objectSchema(properties: JsonRecord, required: readonly string[]) {
  return { additionalProperties: false, properties, required, type: "object" };
}

function uploadArtifact(
  http: E2eHttpClientService,
  auth: Auth,
  key: string,
  language: "javascript" | "python",
  source: string,
) {
  return retryUnavailableHttpRequest(
    `${language} hosted code upload`,
    http.request({
      body: { language, source },
      headers: { ...auth, "idempotency-key": key },
      method: "POST",
      path: "/v1/hosted-code-artifacts",
    }),
  ).pipe(
    Effect.map((response) => {
      const artifact = record(response.json, `${language} hosted code artifact`);
      expect([200, 201], `${language} hosted code upload: ${response.body}`).toContain(
        response.status,
      );
      expect(artifact).toMatchObject({ language, sourceLanguage: language });
      return stringField(artifact, "contentHash", `${language} hosted code artifact`);
    }),
  );
}

function cleanupExtension(http: E2eHttpClientService, auth: Auth, name: string, key: string) {
  const path = `/v1/extensions/${encodeURIComponent(name)}`;
  return http.request({ headers: auth, method: "GET", path }).pipe(
    Effect.flatMap((response) => {
      if (response.status === 404) return Effect.void;
      const current = json(response, 200, `${name} cleanup read`);
      return cleanupHttpRequest(
        `hosted code extension ${name}`,
        http.request({
          body: { expectedVersion: current.version, reason: "E2E cleanup" },
          headers: { ...auth, "idempotency-key": key },
          method: "DELETE",
          path,
        }),
      );
    }),
    Effect.orDie,
  );
}

function acquireExtension(
  http: E2eHttpClientService,
  auth: Auth,
  runKey: string,
  body: JsonRecord & { readonly name: string },
) {
  return Effect.acquireRelease(
    http
      .request({
        body: { defaultPolicyAction: "allow", effect: "execute", requiredScopes: [], ...body },
        headers: { ...auth, "idempotency-key": `${runKey}:${body.name}` },
        method: "POST",
        path: "/v1/extensions",
      })
      .pipe(Effect.map((response) => json(response, 201, `${body.name} extension create`))),
    () => cleanupExtension(http, auth, body.name, `${runKey}:${body.name}:archive`),
  );
}

it.effect.skipIf(!enabled)(
  "proves release-pinned JavaScript and Python hosted code tools with secrets and network isolation",
  () =>
    Effect.gen(function* () {
      const config = yield* scopedE2eConfig;
      const cli = yield* CliProcess;
      const http = yield* E2eHttpClient;
      const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
      const runKey = `e2e-hosted-code-${randomUUID()}`;
      const marker = `hosted-code-proof-${suffix}`;
      const secret = randomBytes(24).toString("hex");
      const secretSha256Prefix = createHash("sha256").update(secret).digest("hex").slice(0, 12);
      const auth = tenantHeaders(config.platformCredential, config);
      const names = {
        javascript: `e2e.hosted.sum.${suffix}`,
        network: `e2e.hosted.egress.${suffix}`,
        python: `e2e.hosted.secret.${suffix}`,
      };

      const javascriptHash = yield* uploadArtifact(
        http,
        auth,
        `${runKey}:upload:javascript`,
        "javascript",
        JAVASCRIPT_SOURCE,
      );
      const pythonHash = yield* uploadArtifact(
        http,
        auth,
        `${runKey}:upload:python`,
        "python",
        PYTHON_SOURCE,
      );
      const networkHash = yield* uploadArtifact(
        http,
        auth,
        `${runKey}:upload:network`,
        "javascript",
        NETWORK_PROBE_SOURCE,
      );
      const shownArtifact = json(
        yield* http.request({
          headers: auth,
          method: "GET",
          path: `/v1/hosted-code-artifacts/${encodeURIComponent(pythonHash)}`,
        }),
        200,
        "python hosted code artifact show",
      );
      expect(shownArtifact).toMatchObject({ contentHash: pythonHash, language: "python" });

      const javascriptTool = yield* acquireExtension(http, auth, runKey, {
        description: `Hosted JavaScript sum proof ${marker}`,
        execution: {
          contentHash: javascriptHash,
          network: "none",
          timeoutMs: 20_000,
          type: "hosted_code",
        },
        inputSchema: objectSchema(
          { a: { type: "number" }, b: { type: "number" }, marker: { type: "string" } },
          ["a", "b", "marker"],
        ),
        name: names.javascript,
        outputSchema: objectSchema({ echo: { type: "string" }, sum: { type: "number" } }, [
          "echo",
          "sum",
        ]),
      });
      const pythonTool = yield* acquireExtension(http, auth, runKey, {
        description: `Hosted Python secret digest proof ${marker}`,
        execution: {
          contentHash: pythonHash,
          memoryMiB: 256,
          network: "none",
          type: "hosted_code",
        },
        inputSchema: objectSchema({ marker: { type: "string" } }, ["marker"]),
        name: names.python,
        outputSchema: objectSchema(
          {
            echo: { type: "string" },
            secretLength: { type: "integer" },
            secretSha256Prefix: { type: "string" },
          },
          ["echo", "secretLength", "secretSha256Prefix"],
        ),
        secrets: { [SECRET_NAME]: secret },
      });
      const networkTool = yield* acquireExtension(http, auth, runKey, {
        description: `Hosted network isolation proof ${marker}`,
        execution: { contentHash: networkHash, network: "none", type: "hosted_code" },
        inputSchema: objectSchema({}, []),
        name: names.network,
        outputSchema: {
          properties: { blocked: { type: "boolean" }, reason: { type: "string" } },
          required: ["blocked"],
          type: "object",
        },
      });
      expect(pythonTool).toMatchObject({
        execution: {
          contentHash: pythonHash,
          language: "python",
          network: "none",
          secretNames: [SECRET_NAME],
          type: "hosted_code",
        },
        status: "active",
      });
      expect(javascriptTool).toMatchObject({
        execution: { entrypoint: "handler", language: "javascript", timeoutMs: 20_000 },
      });
      expect(networkTool).toMatchObject({ execution: { network: "none" } });
      expect(JSON.stringify([javascriptTool, pythonTool, networkTool])).not.toContain(secret);

      const toolRequest = (toolName: string, input: JsonRecord) => ({
        effect: "execute",
        idempotencyKey: `${runKey}:${toolName}`,
        input,
        inputSummary: `E2E hosted code call ${toolName}.`,
        requiredScopes: [],
        toolName,
      });
      const manifest = {
        apiVersion: "agents.deployments.ai/v1",
        kind: "Agent",
        metadata: { key: runKey, name: `E2E hosted code ${runKey}`, version: "1.0.0" },
        spec: {
          capabilities: {
            tools: Object.values(names).map((name) => ({
              authorization: "none",
              name,
              required: true,
              requiredScopes: [],
            })),
          },
          instructions: "Confirm the hosted code tool results in one short sentence.",
          model: liveAgentModel.model,
          runtime: {
            ...liveAgentModel.runtime,
            toolRequests: [
              toolRequest(names.javascript, { a: 19, b: 23, marker }),
              toolRequest(names.python, { marker }),
              toolRequest(names.network, {}),
            ],
          },
          sandbox: {
            minMemoryMiB: 2_048,
            minVcpu: 1,
            mode: "run-ephemeral",
            provider: "aws_lambda_microvm",
          },
          triggers: ["api"],
        },
      };
      const agent = yield* acquireLiveAgent(cli, config, runKey, manifest);
      const runtimeAuth = tenantHeaders(agent.runtimeApiKey, config);
      const submitted = json(
        yield* retryUnavailableHttpRequest(
          "hosted code run submit",
          http.request({
            body: {
              content: `Execute the configured hosted code proof for ${marker}.`,
              title: `Hosted code proof ${runKey}`,
            },
            headers: { ...runtimeAuth, "idempotency-key": `${runKey}:run` },
            method: "POST",
            path: `/v1/agent-deployments/${agent.deploymentId}/runs`,
            timeoutMs: 60_000,
          }),
        ),
        202,
        "hosted code run submit",
      );
      const runId = stringField(record(submitted.run, "submitted.run"), "id", "submitted.run");
      const threadId = stringField(
        record(submitted.thread, "submitted.thread"),
        "id",
        "submitted.thread",
      );

      yield* eventually(
        { label: `completed hosted code run ${runId}`, timeoutMs: 600_000 },
        http
          .request({
            headers: runtimeAuth,
            method: "GET",
            path: `/v1/threads/${threadId}/runs/${runId}`,
          })
          .pipe(
            Effect.map((response) => {
              const run = json(response, 200, "hosted code run get");
              if (run.status === "failed") {
                throw new Error(`Hosted code run failed: ${response.body}`);
              }
              return run.status === "completed" ? run : undefined;
            }),
          ),
      );

      const toolCallsResponse = yield* http.request({
        headers: runtimeAuth,
        method: "GET",
        path: `/v1/runs/${runId}/tool-calls`,
      });
      const calls = records(
        json(toolCallsResponse, 200, "hosted code tool calls").toolCalls,
        "hosted code tool calls.toolCalls",
      );
      const succeeded = (toolName: string, adapterId: unknown, ...fragments: string[]) =>
        expect(calls.filter((call) => call.toolName === toolName)).toEqual([
          expect.objectContaining({
            outputSummary: expect.stringMatching(
              new RegExp(
                fragments
                  .map((fragment) => fragment.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
                  .join(".*"),
                "su",
              ),
            ),
            policyAction: "allow",
            status: "succeeded",
            toolAdapterId: adapterId,
          }),
        ]);
      succeeded(names.javascript, javascriptTool.id, `"echo":"${marker}"`, `"sum":42`);
      succeeded(
        names.python,
        pythonTool.id,
        `"echo":"${marker}"`,
        `"secretLength":${secret.length}`,
        `"secretSha256Prefix":"${secretSha256Prefix}"`,
      );
      succeeded(names.network, networkTool.id, `"blocked":true`);
      expect(toolCallsResponse.body).not.toContain(secret);

      const messagesResponse = yield* http.request({
        headers: runtimeAuth,
        method: "GET",
        path: `/v1/threads/${threadId}/messages`,
      });
      json(messagesResponse, 200, "hosted code thread messages");
      expect(messagesResponse.body).not.toContain(secret);

      const artifactsResponse = yield* http.request({
        headers: runtimeAuth,
        method: "GET",
        path: `/v1/artifacts?runId=${runId}`,
      });
      json(artifactsResponse, 200, "hosted code artifacts");
      expect(artifactsResponse.body).not.toContain(secret);

      const streamSession = json(
        yield* http.request({
          headers: runtimeAuth,
          method: "POST",
          path: `/v1/threads/${threadId}/stream-sessions`,
        }),
        201,
        "hosted code stream session",
      );
      expect(JSON.stringify(streamSession)).not.toContain(secret);
      // The stream gateway serves reads at the absolute streamUrl, not on the API origin.
      const streamResponse = yield* http.request({
        headers: {
          authorization: `Bearer ${stringField(streamSession, "accessToken", "stream session")}`,
        },
        method: "GET",
        path: stringField(streamSession, "streamUrl", "stream session"),
      });
      expect(streamResponse.status, `hosted code stream: ${streamResponse.body}`).toBe(200);
      expect(streamResponse.body).toContain(runId);
      expect(streamResponse.body).not.toContain(secret);
    }).pipe(Effect.provide(CliProcessLive), Effect.provide(httpClientLayer(e2eApiUrl()))),
  900_000,
);
