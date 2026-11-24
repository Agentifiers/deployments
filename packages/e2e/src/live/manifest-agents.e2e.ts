import { expect, it } from "@effect/vitest";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { CliProcess, CliProcessLive } from "../harness/cli-process.ts";
import { eventually } from "../harness/eventually.ts";
import {
  E2eHttpClient,
  type E2eHttpClientService,
  httpClientLayer,
} from "../harness/http-client.ts";
import {
  acquireLiveAgent,
  record,
  redactionSafeRandomId,
  retryUnavailableHttpRequest,
  stringField,
} from "../harness/live-agent.ts";
import { json, records } from "../harness/response-records.ts";
import { credentialedE2eEnabled, e2eApiUrl, featureE2eConfig } from "../harness/live-config.ts";
import { liveAgentModel } from "../harness/live-model.ts";
import { tenantHeaders } from "../harness/platform-credential.ts";

const enabled = credentialedE2eEnabled();

function terminalRun(
  http: E2eHttpClientService,
  auth: Readonly<Record<string, string>>,
  threadId: string,
  runId: string,
) {
  return eventually(
    { label: `terminal run ${runId}`, timeoutMs: 300_000 },
    http
      .request({ headers: auth, method: "GET", path: `/v1/threads/${threadId}/runs/${runId}` })
      .pipe(
        Effect.map((response) => {
          const run = json(response, 200, "run");
          if (run.status === "failed" || run.status === "canceled") {
            throw new Error(`Run ${runId} ended ${String(run.status)}: ${response.body}`);
          }
          return run.status === "completed" ? run : undefined;
        }),
      ),
  );
}

function finalAssistantBody(
  http: E2eHttpClientService,
  auth: Readonly<Record<string, string>>,
  threadId: string,
  runId: string,
) {
  return http
    .request({ headers: auth, method: "GET", path: `/v1/threads/${threadId}/messages` })
    .pipe(
      Effect.map((response) => {
        const page = json(response, 200, "thread messages");
        const assistant = records(page.messages ?? [], "messages").findLast(
          (message) => message.role === "assistant" && message.runId === runId,
        );
        if (!assistant) throw new Error(`Run ${runId} has no assistant message.`);
        return stringField(assistant, "body", "assistant message");
      }),
    );
}

function submitRun(
  http: E2eHttpClientService,
  auth: Readonly<Record<string, string>>,
  deploymentId: string,
  idempotencyKey: string,
  body: Readonly<Record<string, unknown>>,
) {
  return retryUnavailableHttpRequest(
    "run submit",
    http.request({
      body,
      headers: { ...auth, "idempotency-key": idempotencyKey },
      method: "POST",
      path: `/v1/agent-deployments/${deploymentId}/runs`,
      timeoutMs: 60_000,
    }),
  );
}

const verdictFormat = {
  name: "verdict",
  schema: {
    additionalProperties: false,
    properties: {
      confidence: { maximum: 1, minimum: 0, type: "number" },
      verdict: { enum: ["yes", "no"], type: "string" },
    },
    required: ["verdict", "confidence"],
    type: "object",
  },
  type: "json_schema",
} as const;

it.effect.skipIf(!enabled)(
  "enforces a release-pinned response format and rejects a conflicting run format",
  () =>
    Effect.gen(function* () {
      const config = yield* featureE2eConfig;
      const cli = yield* CliProcess;
      const http = yield* E2eHttpClient;
      const runKey = `e2e-format-${randomUUID()}`;
      const agent = yield* acquireLiveAgent(cli, config, runKey, {
        apiVersion: "agents.deployments.ai/v1",
        kind: "Agent",
        metadata: { key: runKey, name: `E2E format ${runKey}`, version: "1.0.0" },
        spec: {
          instructions: "Answer the user's yes/no question.",
          model: liveAgentModel.model,
          runtime: { ...liveAgentModel.runtime, responseFormat: verdictFormat },
          sandbox: { mode: "none" },
          triggers: ["api"],
        },
      });
      const auth = tenantHeaders(agent.runtimeApiKey, config);

      const conflict = yield* submitRun(http, auth, agent.deploymentId, `${runKey}:conflict`, {
        content: "Is water wet?",
        responseFormat: { ...verdictFormat, name: "other" },
      });
      expect(conflict.status, conflict.body).toBe(422);
      expect(conflict.body).toContain("response_format_conflict");

      const submitted = json(
        yield* submitRun(http, auth, agent.deploymentId, `${runKey}:run`, {
          content: "Is the sky blue on a clear day?",
          title: `Format proof ${runKey}`,
        }),
        202,
        "format run submit",
      );
      const runId = stringField(record(submitted.run, "run"), "id", "run");
      const threadId = stringField(record(submitted.thread, "thread"), "id", "thread");
      yield* terminalRun(http, auth, threadId, runId);
      const answer = record(
        JSON.parse(yield* finalAssistantBody(http, auth, threadId, runId)) as unknown,
        "structured answer",
      );
      expect(Object.keys(answer).toSorted()).toEqual(["confidence", "verdict"]);
      expect(["yes", "no"]).toContain(answer.verdict);
      expect(typeof answer.confidence).toBe("number");
      expect(answer.confidence as number).toBeGreaterThanOrEqual(0);
      expect(answer.confidence as number).toBeLessThanOrEqual(1);
    }).pipe(Effect.provide(CliProcessLive), Effect.provide(httpClientLayer(e2eApiUrl()))),
  600_000,
);

it.effect.skipIf(!enabled)(
  "resumes a parent with an awaited declared sub-agent's answer",
  () =>
    Effect.gen(function* () {
      const config = yield* featureE2eConfig;
      const cli = yield* CliProcess;
      const http = yield* E2eHttpClient;
      const runKey = `e2e-subagent-${randomUUID()}`;
      const childKey = `${runKey}-child`;
      const secret = `code-${redactionSafeRandomId()}`;
      const child = yield* acquireLiveAgent(cli, config, childKey, {
        apiVersion: "agents.deployments.ai/v1",
        kind: "Agent",
        metadata: { key: childKey, name: `E2E child ${runKey}`, version: "1.0.0" },
        spec: {
          instructions: `Whatever you are asked, reply exactly: The secret code is ${secret}.`,
          model: liveAgentModel.model,
          runtime: liveAgentModel.runtime,
          sandbox: { mode: "none" },
          triggers: ["api"],
        },
      });
      const parent = yield* acquireLiveAgent(
        cli,
        config,
        runKey,
        {
          apiVersion: "agents.deployments.ai/v1",
          kind: "Agent",
          metadata: { key: runKey, name: `E2E parent ${runKey}`, version: "1.0.0" },
          spec: {
            agents: [
              {
                agentKey: childKey,
                awaitResult: true,
                description: "Knows the secret code; ask it and it answers with the code.",
                key: "keeper",
                required: true,
              },
            ],
            capabilities: {
              tools: [
                {
                  authorization: "none",
                  name: "agent.delegate",
                  required: false,
                  requiredScopes: [],
                },
              ],
            },
            instructions: [
              "You do not know the secret code.",
              'Call agent.delegate exactly once with targetAgentId "keeper" and prompt "What is the secret code?".',
              "Then reply with the secret code exactly as the sub-agent returned it.",
            ].join("\n"),
            model: liveAgentModel.model,
            runtime: { ...liveAgentModel.runtime, modelTools: ["agent.delegate"] },
            sandbox: { mode: "none" },
            triggers: ["api"],
          },
        },
        {
          runtimeConfig: {
            agentBindings: { keeper: { agentDeploymentId: child.deploymentId } },
            apiVersion: "agents.deployments.ai/v1",
            kind: "AgentDeploymentConfig",
          },
        },
      );
      const parentAuth = tenantHeaders(parent.runtimeApiKey, config);
      const childAuth = tenantHeaders(child.runtimeApiKey, config);

      const submitted = json(
        yield* submitRun(http, parentAuth, parent.deploymentId, `${runKey}:run`, {
          content: "What is the secret code?",
          title: `Sub-agent proof ${runKey}`,
        }),
        202,
        "parent run submit",
      );
      const runId = stringField(record(submitted.run, "run"), "id", "run");
      const threadId = stringField(record(submitted.thread, "thread"), "id", "thread");
      const parentRun = yield* terminalRun(http, parentAuth, threadId, runId);
      expect(yield* finalAssistantBody(http, parentAuth, threadId, runId)).toContain(secret);

      const calls = json(
        yield* http.request({
          headers: parentAuth,
          method: "GET",
          path: `/v1/runs/${runId}/tool-calls`,
        }),
        200,
        "parent tool calls",
      );
      const delegation = records(calls.toolCalls ?? [], "parent tool calls").find(
        (call) => call.toolName === "agent.delegate" && call.status === "succeeded",
      );
      if (!delegation)
        throw new Error(`No succeeded agent.delegate call: ${JSON.stringify(calls)}`);
      const childRunId = stringField(delegation, "externalOperationId", "delegate call");
      expect(delegation.outputSummary).toBe(`Sub-agent run ${childRunId} completed.`);

      const childRuns = json(
        yield* http.request({
          headers: childAuth,
          method: "GET",
          path: `/v1/runs?agentDeploymentId=${child.deploymentId}&limit=20`,
        }),
        200,
        "child runs",
      );
      const childRun = records(childRuns.runs ?? [], "child runs").find(
        (run) => run.id === childRunId,
      );
      if (!childRun) throw new Error(`Child run ${childRunId} not listed.`);
      expect(childRun).toMatchObject({ status: "completed", traceId: parentRun.traceId });
      expect(typeof childRun.parentSpanId).toBe("string");
      const childThreadId = stringField(childRun, "threadId", "child run");
      expect(yield* finalAssistantBody(http, childAuth, childThreadId, childRunId)).toContain(
        secret,
      );
    }).pipe(Effect.provide(CliProcessLive), Effect.provide(httpClientLayer(e2eApiUrl()))),
  900_000,
);
