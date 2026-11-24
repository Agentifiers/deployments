import { expect, it } from "@effect/vitest";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { CliProcess, CliProcessLive } from "../harness/cli-process.ts";
import { eventually } from "../harness/eventually.ts";
import { E2eHttpClient, httpClientLayer } from "../harness/http-client.ts";
import {
  acquireLiveAgent,
  cleanupHttpRequest,
  cleanupMemoryHttpRequests,
  record,
  redactionSafeRandomId,
  retryUnavailableHttpRequest,
  stringField,
} from "../harness/live-agent.ts";
import { json, records } from "../harness/response-records.ts";
import {
  credentialedE2eEnabled,
  e2eApiUrl,
  featureE2eConfig,
  safeJwtMetadata,
} from "../harness/live-config.ts";
import { tenantHeaders } from "../harness/platform-credential.ts";
import { liveAgentModel } from "../harness/live-model.ts";

const enabled = credentialedE2eEnabled();

function dataRecord(value: unknown, label: string) {
  return record(record(value, label).data, `${label}.data`);
}

it.effect.skipIf(!enabled)(
  "proves a real tool request, approval, execution, result, and resumed model completion",
  () =>
    Effect.gen(function* () {
      const config = yield* featureE2eConfig;
      const cli = yield* CliProcess;
      const http = yield* E2eHttpClient;
      const runKey = `e2e-tool-${randomUUID()}`;
      const marker = `approved-memory-${redactionSafeRandomId()}`;
      const auth = tenantHeaders(config.platformCredential, config);
      const jwtMetadata = safeJwtMetadata(config.platformCredential.token);

      const spaceRecord = yield* Effect.acquireRelease(
        http
          .request({
            body: { kind: "organization", name: `Tool proof ${runKey}`, retentionDays: 1 },
            headers: { ...auth, "idempotency-key": `${runKey}:space` },
            method: "POST",
            path: "/v1/memory-spaces",
          })
          .pipe(
            Effect.map((response) =>
              json(response, 201, `memory space create (JWT ${jwtMetadata})`),
            ),
          ),
        (created) =>
          cleanupHttpRequest(
            "memory space",
            http.request({
              headers: { ...auth, "idempotency-key": `${runKey}:space:archive` },
              method: "DELETE",
              path: `/v1/memory-spaces/${stringField(dataRecord(created, "memory space"), "id", "memory space.data")}`,
            }),
          ).pipe(Effect.orDie),
      );
      const spaceId = stringField(
        dataRecord(spaceRecord, "memory space"),
        "id",
        "memory space.data",
      );
      const manifest = {
        apiVersion: "agents.deployments.ai/v1",
        kind: "Agent",
        metadata: { key: runKey, name: `E2E tool ${runKey}`, version: "1.0.0" },
        spec: {
          capabilities: {
            tools: [
              {
                authorization: "none",
                name: "agent.memory.save",
                required: false,
                requiredScopes: [],
              },
            ],
          },
          instructions: "After the release-pinned tool result, confirm completion in plain text.",
          memory: { mode: "organization" },
          model: liveAgentModel.model,
          runtime: {
            ...liveAgentModel.runtime,
            toolRequests: [
              {
                effect: "write",
                idempotencyKey: `${runKey}:memory-save`,
                input: { content: marker, memorySpaceId: spaceId, scope: "organization" },
                inputSummary: "E2E requested agent.memory.save.",
                requiredScopes: [],
                toolName: "agent.memory.save",
              },
            ],
          },
          sandbox: { mode: "none" },
          triggers: ["api"],
        },
      };
      const agent = yield* acquireLiveAgent(cli, config, runKey, manifest);
      const runtimeAuth = tenantHeaders(agent.runtimeApiKey, config);
      const grantRecord = yield* Effect.acquireRelease(
        http
          .request({
            body: {
              agentDefinitionId: agent.definitionId,
              memorySpaceId: spaceId,
              permission: "read-write",
            },
            headers: { ...auth, "idempotency-key": `${runKey}:grant` },
            method: "POST",
            path: "/v1/memory-space-grants",
          })
          .pipe(Effect.map((response) => json(response, 201, "memory grant create"))),
        (created) =>
          cleanupHttpRequest(
            "memory grant",
            http.request({
              headers: { ...auth, "idempotency-key": `${runKey}:grant:revoke` },
              method: "DELETE",
              path: `/v1/memory-space-grants/${stringField(dataRecord(created, "memory grant"), "id", "memory grant.data")}`,
            }),
          ).pipe(Effect.orDie),
      );
      expect(dataRecord(grantRecord, "memory grant")).toMatchObject({ permission: "read-write" });

      const submitted = json(
        yield* retryUnavailableHttpRequest(
          "tool run submit",
          http.request({
            body: {
              content: `Confirm the release-pinned tool result for marker ${marker}.`,
              title: `Tool proof ${runKey}`,
            },
            headers: { ...runtimeAuth, "idempotency-key": `${runKey}:run` },
            method: "POST",
            path: `/v1/agent-deployments/${agent.deploymentId}/runs`,
            timeoutMs: 60_000,
          }),
        ),
        202,
        "tool run submit",
      );
      const submittedRun = record(submitted.run, "submitted.run");
      const submittedThread = record(submitted.thread, "submitted.thread");
      const runId = stringField(submittedRun, "id", "submitted.run");
      const threadId = stringField(submittedThread, "id", "submitted.thread");

      const approval = yield* eventually(
        { label: `approval for ${runId}`, timeoutMs: 180_000 },
        http
          .request({
            headers: runtimeAuth,
            method: "GET",
            path: "/v1/approvals?status=pending",
          })
          .pipe(
            Effect.map((response) => {
              const page = json(response, 200, "approval list");
              const approvals = Array.isArray(page.approvals) ? page.approvals : [];
              return approvals
                .map((value, index) => record(value, `approval[${index}]`))
                .find((value) => value.runId === runId && value.status === "pending");
            }),
          ),
      );
      const approvalId = stringField(approval, "id", "approval");
      const toolCallId = stringField(approval, "toolCallId", "approval");
      const waitingCalls = json(
        yield* http.request({
          headers: runtimeAuth,
          method: "GET",
          path: `/v1/runs/${runId}/tool-calls`,
        }),
        200,
        "waiting tool calls",
      );
      expect(waitingCalls.toolCalls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: toolCallId,
            inputSummary: "E2E requested agent.memory.save.",
            policyAction: "require-approval",
            status: "waiting",
            toolName: "agent.memory.save",
          }),
        ]),
      );
      const resolved = json(
        yield* http.request({
          body: { decision: "approved", threadId },
          headers: runtimeAuth,
          method: "POST",
          path: `/v1/runs/${runId}/approvals/${approvalId}/resolve`,
        }),
        200,
        "approval resolve",
      );
      expect(resolved).toMatchObject({ decision: "approved" });

      const seenApprovalIds = new Set([approvalId]);
      yield* eventually(
        { label: `resumed run ${runId}`, timeoutMs: 180_000 },
        http
          .request({
            headers: runtimeAuth,
            method: "GET",
            path: `/v1/threads/${threadId}/runs/${runId}`,
          })
          .pipe(
            Effect.flatMap((response) => {
              const run = json(response, 200, "resumed run");
              if (run.status === "failed") throw new Error(`Resumed run failed: ${response.body}`);
              if (run.status === "completed") return Effect.succeed(run);
              if (run.status !== "waiting-for-approval") return Effect.succeed(undefined);
              return http
                .request({
                  headers: runtimeAuth,
                  method: "GET",
                  path: "/v1/approvals?status=pending",
                })
                .pipe(
                  Effect.flatMap((pendingResponse) => {
                    const page = json(pendingResponse, 200, "repeated approval list");
                    const next = records(page.approvals ?? [], "repeated approvals").find(
                      (candidate) =>
                        candidate.runId === runId &&
                        candidate.status === "pending" &&
                        !seenApprovalIds.has(String(candidate.id)),
                    );
                    if (!next) return Effect.succeed(undefined);
                    const nextApprovalId = stringField(next, "id", "repeated approval");
                    seenApprovalIds.add(nextApprovalId);
                    if (seenApprovalIds.size > 4) {
                      return Effect.die(
                        new Error("Model exceeded the bounded approval proof loop."),
                      );
                    }
                    return http
                      .request({
                        body: { decision: "approved", threadId },
                        headers: runtimeAuth,
                        method: "POST",
                        path: `/v1/runs/${runId}/approvals/${nextApprovalId}/resolve`,
                      })
                      .pipe(
                        Effect.map((nextResolution) => {
                          json(nextResolution, 200, "repeated approval resolve");
                          return undefined;
                        }),
                      );
                  }),
                );
            }),
          ),
      );
      const completedCalls = json(
        yield* http.request({
          headers: runtimeAuth,
          method: "GET",
          path: `/v1/runs/${runId}/tool-calls`,
        }),
        200,
        "completed tool calls",
      );
      expect(completedCalls.toolCalls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: toolCallId,
            policyAction: "require-approval",
            status: "succeeded",
            toolName: "agent.memory.save",
          }),
        ]),
      );
      expect(
        records(completedCalls.toolCalls ?? [], "completed tool calls").filter(
          (call) =>
            call.inputSummary === "E2E requested agent.memory.save." && call.status === "succeeded",
        ),
      ).toHaveLength(seenApprovalIds.size);
      const messages = json(
        yield* http.request({
          headers: runtimeAuth,
          method: "GET",
          path: `/v1/threads/${threadId}/messages`,
        }),
        200,
        "tool run messages",
      );
      expect(messages.messages).toEqual(
        expect.arrayContaining([expect.objectContaining({ role: "assistant" })]),
      );

      const savedMemories = yield* eventually(
        { label: `durable tool memories for ${runId}`, timeoutMs: 180_000 },
        http
          .request({
            headers: auth,
            method: "GET",
            path: `/v1/memory?space=${spaceId}&limit=20`,
          })
          .pipe(
            Effect.map((response) => {
              const page = json(response, 200, "saved tool memories");
              const memories = records(page.items ?? [], "saved tool memories.items")
                .map((item) => dataRecord(item, "saved tool memory"))
                .filter((memory) => memory.sourceRunId === runId);
              return memories.length >= seenApprovalIds.size ? memories : undefined;
            }),
          ),
      );
      const savedMemoryIds = savedMemories.map((memory) =>
        stringField(memory, "id", "saved tool memory.data"),
      );
      expect(savedMemories).toEqual(
        expect.arrayContaining([expect.objectContaining({ body: marker, sourceRunId: runId })]),
      );
      for (const memoryId of savedMemoryIds) {
        yield* cleanupMemoryHttpRequests(
          `tool memory ${memoryId}`,
          http.request({
            headers: { ...auth, "idempotency-key": `${runKey}:memory:archive:${memoryId}` },
            method: "POST",
            path: `/v1/memory/${memoryId}/archive`,
          }),
          http.request({
            body: { reason: "E2E cleanup" },
            headers: { ...auth, "idempotency-key": `${runKey}:memory:delete:${memoryId}` },
            method: "POST",
            path: `/v1/memory/${memoryId}/delete`,
          }),
        );
      }
    }).pipe(Effect.provide(CliProcessLive), Effect.provide(httpClientLayer(e2eApiUrl()))),
  600_000,
);
