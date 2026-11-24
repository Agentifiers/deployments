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
import { credentialedE2eEnabled, e2eApiUrl, scopedE2eConfig } from "../harness/live-config.ts";
import { tenantHeaders } from "../harness/platform-credential.ts";
import { liveAgentModel } from "../harness/live-model.ts";

const enabled = credentialedE2eEnabled();

function archiveExtension(
  http: E2eHttpClientService,
  auth: Readonly<Record<string, string>>,
  toolName: string,
  key: string,
) {
  const path = `/v1/extensions/${encodeURIComponent(toolName)}`;
  return http.request({ headers: auth, method: "GET", path }).pipe(
    Effect.flatMap((response) => {
      if (response.status === 404) return Effect.void;
      const current = json(response, 200, "client extension cleanup read");
      return cleanupHttpRequest(
        "client extension",
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

it.effect.skipIf(!enabled)(
  "pauses a deployed run on a client-executed tool and resumes it with submitted output",
  () =>
    Effect.gen(function* () {
      const config = yield* scopedE2eConfig;
      const cli = yield* CliProcess;
      const http = yield* E2eHttpClient;
      const runKey = `e2e-client-tool-${randomUUID()}`;
      const marker = `client-proof-${randomUUID().slice(0, 8)}`;
      const toolName = `e2e.client.lookup.${randomUUID().replaceAll("-", "").slice(0, 16)}`;
      const auth = tenantHeaders(config.platformCredential, config);

      const extension = yield* Effect.acquireRelease(
        http
          .request({
            body: {
              defaultPolicyAction: "allow",
              description: "Looks up a value on the caller's device.",
              effect: "read",
              execution: { timeoutMs: 600_000, type: "client" },
              inputSchema: {
                additionalProperties: false,
                properties: { key: { type: "string" } },
                required: ["key"],
                type: "object",
              },
              name: toolName,
              outputSchema: {
                properties: { value: { type: "string" } },
                required: ["value"],
                type: "object",
              },
              requiredScopes: [],
            },
            headers: { ...auth, "idempotency-key": `${runKey}:extension` },
            method: "POST",
            path: "/v1/extensions",
          })
          .pipe(Effect.map((response) => json(response, 201, "client extension create"))),
        () => archiveExtension(http, auth, toolName, `${runKey}:extension:archive`),
      );
      expect(extension).toMatchObject({
        execution: { timeoutMs: 600_000, type: "client" },
        hasCallbackAuth: false,
        name: toolName,
        status: "active",
      });

      const manifest = {
        apiVersion: "agents.deployments.ai/v1",
        kind: "Agent",
        metadata: { key: runKey, name: `E2E client tool agent ${runKey}`, version: "1.0.0" },
        spec: {
          capabilities: {
            tools: [{ authorization: "none", name: toolName, required: true, requiredScopes: [] }],
          },
          instructions:
            "Reply with exactly the value returned by the client lookup tool and nothing else.",
          model: liveAgentModel.model,
          runtime: {
            ...liveAgentModel.runtime,
            toolRequests: [
              {
                effect: "read",
                idempotencyKey: `${runKey}:tool-call`,
                input: { key: "proof" },
                inputSummary: "Look up the proof value on the client.",
                requiredScopes: [],
                toolName,
              },
            ],
          },
          sandbox: { mode: "none" },
          triggers: ["api"],
        },
      };
      const agent = yield* acquireLiveAgent(cli, config, runKey, manifest);
      const runtimeAuth = tenantHeaders(agent.runtimeApiKey, config);
      const submitted = json(
        yield* retryUnavailableHttpRequest(
          "client tool run submit",
          http.request({
            body: { content: "Look up the proof value.", title: `Client tool ${runKey}` },
            headers: { ...runtimeAuth, "idempotency-key": `${runKey}:run` },
            method: "POST",
            path: `/v1/agent-deployments/${agent.deploymentId}/runs`,
            timeoutMs: 60_000,
          }),
        ),
        202,
        "client tool run submit",
      );
      const runId = stringField(record(submitted.run, "run"), "id", "run");
      const threadId = stringField(record(submitted.thread, "thread"), "id", "thread");

      const pending = yield* eventually(
        { label: `pending client tool on ${runId}`, timeoutMs: 180_000 },
        http
          .request({ headers: runtimeAuth, method: "GET", path: `/v1/runs/${runId}/tool-calls` })
          .pipe(
            Effect.map((response) =>
              records(json(response, 200, "tool calls").toolCalls, "toolCalls").find(
                (call) => call.executionType === "client" && call.status === "running",
              ),
            ),
          ),
      );
      expect(pending).toMatchObject({
        executionType: "client",
        externalOperationId: pending.id,
        input: { key: "proof" },
        toolName,
      });
      expect(typeof pending.expiresAt).toBe("string");
      const toolCallId = stringField(pending, "id", "pending client tool call");

      const resultPath = `/v1/runs/${runId}/tool-calls/${toolCallId}/results`;
      const invalid = yield* http.request({
        body: { outcome: "completed", output: { wrong: marker }, threadId },
        headers: runtimeAuth,
        method: "POST",
        path: resultPath,
      });
      expect(invalid.status, invalid.body).toBe(400);

      const body = { outcome: "completed", output: { value: marker }, threadId };
      const resolved = json(
        yield* http.request({ body, headers: runtimeAuth, method: "POST", path: resultPath }),
        200,
        "client tool result",
      );
      expect(record(resolved.toolCall, "resolved tool call")).toMatchObject({
        output: { value: marker },
        status: "succeeded",
      });
      const replay = yield* http.request({
        body,
        headers: runtimeAuth,
        method: "POST",
        path: resultPath,
      });
      expect(replay.status, replay.body).toBe(200);
      const conflict = yield* http.request({
        body: { ...body, output: { value: "different" } },
        headers: runtimeAuth,
        method: "POST",
        path: resultPath,
      });
      expect(conflict.status, conflict.body).toBe(409);

      yield* eventually(
        { label: `completed client tool run ${runId}`, timeoutMs: 240_000 },
        http
          .request({
            headers: runtimeAuth,
            method: "GET",
            path: `/v1/threads/${threadId}/runs/${runId}`,
          })
          .pipe(
            Effect.map((response) => {
              const current = json(response, 200, "run get");
              if (current.status === "failed") throw new Error(`Run failed: ${response.body}`);
              return current.status === "completed" ? current : undefined;
            }),
          ),
      );
      const messages = records(
        json(
          yield* http.request({
            headers: runtimeAuth,
            method: "GET",
            path: `/v1/threads/${threadId}/messages`,
          }),
          200,
          "thread messages",
        ).messages,
        "messages",
      );
      expect(
        messages.some(
          (message) => message.role === "assistant" && String(message.body).includes(marker),
        ),
      ).toBe(true);
    }).pipe(Effect.provide(CliProcessLive), Effect.provide(httpClientLayer(e2eApiUrl()))),
  600_000,
);
