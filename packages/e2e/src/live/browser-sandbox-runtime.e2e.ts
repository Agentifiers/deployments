import { LambdaMicrovmsClient, paginateListMicrovms } from "@aws-sdk/client-lambda-microvms";
import { expect, it } from "@effect/vitest";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { CliProcess, CliProcessLive } from "../harness/cli-process.ts";
import { eventually } from "../harness/eventually.ts";
import { E2eHttpClient, httpClientLayer } from "../harness/http-client.ts";
import {
  acquireLiveAgent,
  record,
  retryUnavailableHttpRequest,
  stringField,
} from "../harness/live-agent.ts";
import { json, records } from "../harness/response-records.ts";
import { credentialedE2eEnabled, e2eApiUrl, scopedE2eConfig } from "../harness/live-config.ts";
import { tenantHeaders } from "../harness/platform-credential.ts";
import { liveAgentModel } from "../harness/live-model.ts";

const enabled = credentialedE2eEnabled();
const browserUrl = "https://deployments.ai/capabilities";

async function activeLambdaMicrovms() {
  const active: string[] = [];
  const client = new LambdaMicrovmsClient({ region: process.env.AWS_REGION ?? "us-east-2" });
  for await (const page of paginateListMicrovms({ client }, {})) {
    for (const microvm of page.items ?? []) {
      if (microvm.state !== "TERMINATED") active.push(microvm.microvmId ?? "unknown");
    }
  }
  client.destroy();
  return active;
}

function noAdditionalLambdaMicrovms(label: string, baseline: ReadonlySet<string>) {
  return eventually(
    { label, timeoutMs: 180_000 },
    Effect.tryPromise({
      try: activeLambdaMicrovms,
      catch: (cause) => new Error("Unable to list Lambda MicroVMs.", { cause }),
    }).pipe(
      Effect.map((active) => {
        const additional = active.filter((microvmId) => !baseline.has(microvmId));
        return additional.length === 0 ? additional : undefined;
      }),
    ),
  );
}

it.effect.skipIf(!enabled)(
  "proves hosted browser actions and sandboxed code with complete MicroVM cleanup",
  () =>
    Effect.gen(function* () {
      const config = yield* scopedE2eConfig;
      const cli = yield* CliProcess;
      const http = yield* E2eHttpClient;
      const microvmBaseline = new Set(yield* Effect.promise(activeLambdaMicrovms));

      const runKey = `e2e-browser-sandbox-${randomUUID()}`;
      const codeMarker = `sandbox-runtime-proof-${runKey}`;
      const manifest = {
        apiVersion: "agents.deployments.ai/v1",
        kind: "Agent",
        metadata: {
          key: runKey,
          name: `E2E browser sandbox ${runKey}`,
          version: "1.0.0",
        },
        spec: {
          capabilities: {
            tools: ["code.execute", "browser.session.plan", "browser.session.execute"].map(
              (name) => ({
                authorization: "none",
                name,
                required: false,
                requiredScopes: [],
              }),
            ),
          },
          instructions: [
            "Perform the browser runtime proof after the two preconfigured tools complete.",
            `Call browser.session.execute exactly once for ${browserUrl}.`,
            "Copy sessionPlanId exactly from the completed browser.session.plan result summary.",
            'Use actions [{"type":"wait","selector":"body"},{"type":"scroll","y":400}] and timeoutMs 60000.',
            "After browser.session.execute completes, reply with one short confirmation and do not call another tool.",
          ].join(" "),
          model: liveAgentModel.model,
          runtime: {
            ...liveAgentModel.runtime,
            modelTools: ["browser.session.execute"],
            toolRequests: [
              {
                effect: "execute",
                idempotencyKey: `${runKey}:code`,
                input: {
                  code: `printf '${codeMarker}:%s\\n' "$(uname -m)"`,
                  language: "bash",
                  timeoutMs: 30_000,
                },
                inputSummary: "E2E requested code.execute in Lambda MicroVM.",
                requiredScopes: [],
                toolName: "code.execute",
              },
              {
                effect: "write",
                idempotencyKey: `${runKey}:browser-plan`,
                input: { url: browserUrl },
                inputSummary: "E2E requested browser.session.plan.",
                requiredScopes: [],
                toolName: "browser.session.plan",
              },
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
      const auth = tenantHeaders(agent.runtimeApiKey, config);
      const submitted = json(
        yield* retryUnavailableHttpRequest(
          "browser and sandbox run submit",
          http.request({
            body: {
              content: "Execute the configured browser and sandbox runtime proof.",
              title: `Browser and sandbox proof ${runKey}`,
            },
            headers: { ...auth, "idempotency-key": `${runKey}:run` },
            method: "POST",
            path: `/v1/agent-deployments/${agent.deploymentId}/runs`,
            timeoutMs: 60_000,
          }),
        ),
        202,
        "browser and sandbox run submit",
      );
      const runId = stringField(record(submitted.run, "submitted.run"), "id", "submitted.run");
      const threadId = stringField(
        record(submitted.thread, "submitted.thread"),
        "id",
        "submitted.thread",
      );

      const resolveNextApproval = (expectedToolName: string, seen: ReadonlySet<string>) =>
        eventually(
          { label: `${expectedToolName} approval for ${runId}`, timeoutMs: 300_000 },
          http
            .request({
              headers: auth,
              method: "GET",
              path: "/v1/approvals?status=pending",
            })
            .pipe(
              Effect.map((response) => {
                const approvals = records(
                  json(response, 200, `${expectedToolName} approval list`).approvals ?? [],
                  `${expectedToolName} approval list.approvals`,
                );
                return approvals.find(
                  (approval) =>
                    approval.runId === runId &&
                    approval.status === "pending" &&
                    !seen.has(String(approval.id)),
                );
              }),
            ),
        ).pipe(
          Effect.flatMap((approval) => {
            const approvalId = stringField(approval, "id", `${expectedToolName} approval`);
            const toolCallId = stringField(approval, "toolCallId", `${expectedToolName} approval`);
            return http
              .request({
                headers: auth,
                method: "GET",
                path: `/v1/runs/${runId}/tool-calls`,
              })
              .pipe(
                Effect.flatMap((response) => {
                  const toolCall = records(
                    json(response, 200, `${expectedToolName} tool call list`).toolCalls,
                    `${expectedToolName} tool call list.toolCalls`,
                  ).find((candidate) => candidate.id === toolCallId);
                  expect(toolCall?.toolName).toBe(expectedToolName);
                  return http.request({
                    body: { decision: "approved", threadId },
                    headers: auth,
                    method: "POST",
                    path: `/v1/runs/${runId}/approvals/${approvalId}/resolve`,
                  });
                }),
                Effect.map((response) => {
                  expect(json(response, 200, `${expectedToolName} approval resolve`)).toMatchObject(
                    { decision: "approved" },
                  );
                  return approvalId;
                }),
              );
          }),
        );

      const planApprovalId = yield* resolveNextApproval("browser.session.plan", new Set());
      const executeApprovalId = yield* resolveNextApproval(
        "browser.session.execute",
        new Set([planApprovalId]),
      );

      yield* eventually(
        { label: `completed browser and sandbox run ${runId}`, timeoutMs: 600_000 },
        http
          .request({
            headers: auth,
            method: "GET",
            path: `/v1/threads/${threadId}/runs/${runId}`,
          })
          .pipe(
            Effect.flatMap((response) => {
              const run = json(response, 200, "browser and sandbox run get");
              if (run.status === "failed") {
                return Effect.die(new Error(`Browser and sandbox run failed: ${response.body}`));
              }
              if (run.status === "waiting-for-approval") {
                return http
                  .request({
                    headers: auth,
                    method: "GET",
                    path: "/v1/approvals?status=pending",
                  })
                  .pipe(
                    Effect.flatMap((approvalResponse) => {
                      const unexpected = records(
                        json(approvalResponse, 200, "unexpected approval list").approvals ?? [],
                        "unexpected approval list.approvals",
                      ).find(
                        (approval) =>
                          approval.runId === runId &&
                          approval.status === "pending" &&
                          ![planApprovalId, executeApprovalId].includes(String(approval.id)),
                      );
                      return unexpected
                        ? Effect.die(
                            new Error(
                              `Browser proof requested unexpected additional approval for ${String(unexpected.toolName)}.`,
                            ),
                          )
                        : Effect.succeed(undefined);
                    }),
                  );
              }
              return Effect.succeed(run.status === "completed" ? run : undefined);
            }),
          ),
      );

      const calls = records(
        json(
          yield* http.request({
            headers: auth,
            method: "GET",
            path: `/v1/runs/${runId}/tool-calls`,
          }),
          200,
          "browser and sandbox tool calls",
        ).toolCalls,
        "browser and sandbox tool calls.toolCalls",
      );
      expect(calls.filter((call) => call.toolName === "code.execute")).toEqual([
        expect.objectContaining({
          outputSummary: expect.stringContaining(codeMarker),
          policyAction: "allow",
          status: "succeeded",
        }),
      ]);
      expect(calls.filter((call) => call.toolName === "browser.session.plan")).toEqual([
        expect.objectContaining({
          outputSummary: expect.stringMatching(
            /^Prepared browser session plan [0-9A-HJKMNP-TV-Z]{26} for https:\/\/deployments\.ai\.$/u,
          ),
          policyAction: "require-approval",
          status: "succeeded",
        }),
      ]);
      expect(calls.filter((call) => call.toolName === "browser.session.execute")).toEqual([
        expect.objectContaining({
          outputSummary: expect.stringContaining(
            "Executed 2 browser actions and captured rendered evidence",
          ),
          policyAction: "require-approval",
          status: "succeeded",
        }),
      ]);

      yield* noAdditionalLambdaMicrovms(
        `Lambda MicroVM cleanup beyond baseline after run ${runId}`,
        microvmBaseline,
      );
    }).pipe(Effect.provide(CliProcessLive), Effect.provide(httpClientLayer(e2eApiUrl()))),
  900_000,
);
