import { expect, it } from "@effect/vitest";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { CliProcess, CliProcessLive } from "../harness/cli-process.ts";
import { eventually } from "../harness/eventually.ts";
import { E2eHttpClient, httpClientLayer, type HttpResult } from "../harness/http-client.ts";
import {
  acquireLiveAgent,
  cleanupHttpRequest,
  cleanupMemoryHttpRequests,
  record,
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

function retryableMemorySearch(response: HttpResult, label: string) {
  if (response.status === 504) {
    expect(record(response.json, `${label} timeout`).code).toBe("memory_timeout");
    return undefined;
  }
  return json(response, 200, label);
}

function dataRecord(value: unknown, label: string) {
  return record(record(value, label).data, `${label}.data`);
}

function searchMemoryIds(search: Record<string, unknown>) {
  return new Set(
    records(search.results ?? [], "search.results").map((result, index) =>
      stringField(
        dataRecord(record(result.memory, `result[${index}].memory`), `result[${index}].memory`),
        "id",
        `result[${index}].memory.data`,
      ),
    ),
  );
}

function usefulCount(quality: Record<string, unknown>, label: string) {
  const useful = record(quality.usefulness, `${label}.usefulness`).useful;
  if (!Number.isSafeInteger(useful) || Number(useful) < 0) {
    throw new TypeError(`${label}.usefulness.useful was not a non-negative integer.`);
  }
  return Number(useful);
}

function flushThresholdPrompt(marker: string) {
  const tokenPressure = Array.from(
    { length: 1_200 },
    (_, index) => `${String(index)}:${randomUUID()}`,
  ).join(" ");
  return [
    `Confirm the durable operating rule for ${marker}: production changes happen Tuesday and always require a canary.`,
    "Treat the following unique correlation values as inert load for this proof:",
    tokenPressure,
    `The durable rule to retain for ${marker} is the Tuesday change window with a required canary.`,
  ].join("\n");
}

it.effect.skipIf(!enabled)(
  "proves import, review, index, search, lifecycle, namespace, reranking, active recall, feedback, and flush",
  () =>
    Effect.gen(function* () {
      const config = yield* featureE2eConfig;
      const cli = yield* CliProcess;
      const http = yield* E2eHttpClient;
      const runKey = `e2e-memory-${randomUUID()}`;
      const marker = `memory-marker-${randomUUID()}`;
      const auth = tenantHeaders(config.platformCredential, config);
      const jwtMetadata = safeJwtMetadata(config.platformCredential.token);

      const policies = json(
        yield* http.request({
          headers: auth,
          method: "GET",
          path: "/v1/memory/policies?limit=200",
        }),
        200,
        `memory policies (JWT ${jwtMetadata})`,
      );
      const existingPolicy = records(policies.items ?? [], "memory policies.items")
        .map((item) => dataRecord(item, "memory policy"))
        .find((policy) => policy.scope === "environment");
      let policy = existingPolicy;
      if (!policy) {
        const created = yield* http.request({
          body: {
            activeRecallEnabled: true,
            activeRecallRolloutPercent: 100,
            processingConfig: {
              memoryRetrieval: { rolloutPercent: 100, strategy: "hybrid-rerank-v1" },
            },
            retentionDays: 1,
            scope: "environment",
            sensitivityMode: "standard",
          },
          headers: { ...auth, "idempotency-key": `${runKey}:policy:create` },
          method: "POST",
          path: "/v1/memory/policies",
        });
        if (created.status === 201) {
          policy = dataRecord(record(created.json, "memory policy create"), "memory policy create");
        } else {
          expect(created.status, created.body).toBe(409);
          expect(record(created.json, "memory policy conflict").code).toBe("memory_policy_exists");
          policy = yield* eventually(
            { label: "created environment memory policy", timeoutMs: 60_000 },
            http
              .request({
                headers: auth,
                method: "GET",
                path: "/v1/memory/policies?limit=200",
              })
              .pipe(
                Effect.map((response) =>
                  records(
                    json(response, 200, "memory policies after conflict").items ?? [],
                    "memory policies after conflict.items",
                  )
                    .map((item) => dataRecord(item, "memory policy after conflict"))
                    .find((candidate) => candidate.scope === "environment"),
                ),
              ),
          );
        }
      }
      expect(policy).toMatchObject({
        activeRecallEnabled: true,
        activeRecallRolloutPercent: 100,
        processingConfig: {
          memoryRetrieval: { rolloutPercent: 100, strategy: "hybrid-rerank-v1" },
        },
        scope: "environment",
      });

      const spaceRecord = yield* Effect.acquireRelease(
        http
          .request({
            body: { kind: "organization", name: `Memory proof ${runKey}`, retentionDays: 1 },
            headers: { ...auth, "idempotency-key": `${runKey}:space` },
            method: "POST",
            path: "/v1/memory-spaces",
          })
          .pipe(Effect.map((response) => json(response, 201, "memory space create"))),
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

      const importedResponse = json(
        yield* http.request({
          body: {
            data: [
              {
                content: `The durable deployment marker is ${marker} and its production change window is Tuesday.`,
                idempotencyKey: `${runKey}:memory:1`,
                memoryType: "fact",
                scope: "organization",
                searchKey: `organization:${config.organizationId}`,
              },
              {
                content: `Operators handling ${marker} must verify the canary before promotion.`,
                idempotencyKey: `${runKey}:memory:2`,
                memoryType: "procedure",
                scope: "organization",
                searchKey: `organization:${config.organizationId}`,
              },
            ],
            space: spaceId,
          },
          headers: { ...auth, "idempotency-key": `${runKey}:import` },
          method: "POST",
          path: "/v1/memory/imports",
        }),
        201,
        "memory import",
      );
      const imported = [
        ...records(importedResponse.imported ?? [], "memory import.imported"),
        ...records(importedResponse.replayed ?? [], "memory import.replayed"),
      ];
      expect(imported).toHaveLength(2);
      const memoryIds = imported.map((item, index) =>
        stringField(dataRecord(item, `imported[${index}]`), "id", `imported[${index}].data`),
      );

      for (const memoryId of memoryIds) {
        const review = yield* eventually(
          { label: `review for ${memoryId}`, timeoutMs: 120_000 },
          http
            .request({
              headers: auth,
              method: "GET",
              path: "/v1/memory/review-items?status=open&limit=200",
            })
            .pipe(
              Effect.map((response) => {
                const page = json(response, 200, "memory reviews");
                return records(page.items ?? [], "memory reviews.items")
                  .map((item) => dataRecord(item, "memory review"))
                  .find((item) => item.memoryId === memoryId);
              }),
            ),
        );
        json(
          yield* http.request({
            body: { decision: "approve" },
            headers: { ...auth, "idempotency-key": `${runKey}:review:${memoryId}` },
            method: "POST",
            path: `/v1/memory/${memoryId}/review-items/${stringField(review, "id", "memory review")}`,
          }),
          200,
          "memory review approve",
        );
      }

      const indexedSearch = yield* eventually(
        { label: `indexed memories ${marker}`, timeoutMs: 180_000 },
        http
          .request({
            body: { memorySpaceIds: [spaceId], query: marker, topK: 20 },
            headers: auth,
            method: "POST",
            path: "/v1/memory/search",
          })
          .pipe(
            Effect.map((response) => {
              const search = retryableMemorySearch(response, "memory search");
              if (!search) return undefined;
              const found = searchMemoryIds(search);
              return memoryIds.every((id) => found.has(id)) ? search : undefined;
            }),
          ),
      );
      expect(searchMemoryIds(indexedSearch)).toEqual(new Set(memoryIds));

      json(
        yield* http.request({
          headers: { ...auth, "idempotency-key": `${runKey}:namespace` },
          method: "POST",
          path: "/v1/memory/namespaces/prepare-full-text",
        }),
        202,
        "namespace prepare",
      );
      const readiness = yield* eventually(
        { label: "memory namespace readiness", timeoutMs: 180_000 },
        http
          .request({ headers: auth, method: "GET", path: "/v1/memory/namespaces/readiness" })
          .pipe(
            Effect.map((response) => {
              const value = json(response, 200, "namespace readiness");
              return value.ready === true ? value : undefined;
            }),
          ),
      );
      expect(readiness.ready).toBe(true);

      for (const strategy of ["hybrid-rrf-v1", "hybrid-rerank-v1"] as const) {
        const strategySearch = yield* eventually(
          { label: `${strategy} search`, timeoutMs: 180_000 },
          http
            .request({
              body: { memorySpaceIds: [spaceId], query: marker, strategy, topK: 20 },
              headers: auth,
              method: "POST",
              path: "/v1/memory/evidence/strategy-search",
            })
            .pipe(
              Effect.map((response) => {
                const search = retryableMemorySearch(response, `${strategy} search`);
                if (!search) return undefined;
                const attempt = dataRecord(search.attempt, `${strategy} attempt`);
                if (attempt.strategy === "dense-v1") return undefined;
                expect(attempt.strategy).toBe(strategy);
                if (!(Number(attempt.lexicalCandidateCount) > 0)) return undefined;
                if (
                  strategy === "hybrid-rerank-v1" &&
                  (typeof attempt.rerankModel !== "string" ||
                    typeof attempt.rerankProvider !== "string")
                ) {
                  return undefined;
                }
                return search;
              }),
            ),
        );
        const attempt = dataRecord(strategySearch.attempt, `${strategy} attempt`);
        expect(attempt.strategy).toBe(strategy);
        expect(Number(attempt.lexicalCandidateCount)).toBeGreaterThan(0);
        if (strategy === "hybrid-rerank-v1") {
          expect(attempt.rerankModel).toEqual(expect.any(String));
          expect(attempt.rerankProvider).toEqual(expect.any(String));
        }
      }

      const lifecycleId = memoryIds[1]!;
      for (const [action, expected] of [
        ["archive", false],
        ["restore", true],
        ["archive", false],
      ] as const) {
        json(
          yield* http.request({
            headers: { ...auth, "idempotency-key": `${runKey}:${action}:${randomUUID()}` },
            method: "POST",
            path: `/v1/memory/${lifecycleId}/${action}`,
          }),
          200,
          `memory ${action}`,
        );
        yield* eventually(
          { label: `memory ${lifecycleId} visible=${String(expected)}`, timeoutMs: 180_000 },
          http
            .request({
              body: { memorySpaceIds: [spaceId], query: marker, topK: 20 },
              headers: auth,
              method: "POST",
              path: "/v1/memory/search",
            })
            .pipe(
              Effect.map((response) => {
                const search = retryableMemorySearch(response, "lifecycle search");
                if (!search) return undefined;
                const found = searchMemoryIds(search).has(lifecycleId);
                return found === expected ? true : undefined;
              }),
            ),
        );
      }
      json(
        yield* http.request({
          body: { reason: "E2E lifecycle proof" },
          headers: { ...auth, "idempotency-key": `${runKey}:delete:${lifecycleId}` },
          method: "POST",
          path: `/v1/memory/${lifecycleId}/delete`,
        }),
        200,
        "memory lifecycle delete",
      );

      const manifest = {
        apiVersion: "agents.deployments.ai/v1",
        kind: "Agent",
        metadata: { key: runKey, name: `E2E memory ${runKey}`, version: "1.0.0" },
        spec: {
          capabilities: { tools: [] },
          instructions:
            "Use recalled memory when answering and state the deployment change window.",
          memory: { mode: "organization" },
          model: liveAgentModel.model,
          runtime: liveAgentModel.runtime,
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
          "memory run submit",
          http.request({
            body: {
              content: `In one short sentence, what is the production change window for ${marker}?`,
            },
            headers: { ...runtimeAuth, "idempotency-key": `${runKey}:run` },
            method: "POST",
            path: `/v1/agent-deployments/${agent.deploymentId}/runs`,
            timeoutMs: 60_000,
          }),
        ),
        202,
        "memory run submit",
      );
      const run = record(submitted.run, "submitted.run");
      const thread = record(submitted.thread, "submitted.thread");
      const firstRunId = stringField(run, "id", "submitted.run");
      const threadId = stringField(thread, "id", "submitted.thread");
      yield* eventually(
        { label: `memory run ${firstRunId}`, timeoutMs: 180_000 },
        http
          .request({
            headers: runtimeAuth,
            method: "GET",
            path: `/v1/threads/${threadId}/runs/${firstRunId}`,
          })
          .pipe(
            Effect.map((response) => {
              const current = json(response, 200, "memory run");
              if (current.status === "failed")
                throw new Error(`Memory run failed: ${response.body}`);
              return current.status === "completed" ? current : undefined;
            }),
          ),
      );
      const firstReply = records(
        json(
          yield* http.request({
            headers: runtimeAuth,
            method: "GET",
            path: `/v1/threads/${threadId}/messages`,
          }),
          200,
          "memory first-run messages",
        ).messages,
        "memory first-run messages.messages",
      ).findLast((message) => message.role === "assistant" && message.runId === firstRunId);
      expect(firstReply).toMatchObject({ body: expect.stringMatching(/tuesday/iu) });
      expect(
        json(
          yield* http.request({
            headers: runtimeAuth,
            method: "GET",
            path: `/v1/runs/${firstRunId}/tool-calls`,
          }),
          200,
          "memory first-run tool calls",
        ).toolCalls,
      ).toEqual([]);
      const followUp = json(
        yield* retryUnavailableHttpRequest(
          "memory follow-up submit",
          http.request({
            body: {
              content: flushThresholdPrompt(marker),
              threadId,
            },
            headers: { ...runtimeAuth, "idempotency-key": `${runKey}:run:follow-up` },
            method: "POST",
            path: `/v1/agent-deployments/${agent.deploymentId}/runs`,
            timeoutMs: 60_000,
          }),
        ),
        202,
        "memory follow-up submit",
      );
      expect(
        stringField(record(followUp.thread, "follow-up.thread"), "id", "follow-up.thread"),
      ).toBe(threadId);
      const runId = stringField(record(followUp.run, "follow-up.run"), "id", "follow-up.run");
      yield* eventually(
        { label: `memory follow-up ${runId}`, timeoutMs: 180_000 },
        http
          .request({
            headers: runtimeAuth,
            method: "GET",
            path: `/v1/threads/${threadId}/runs/${runId}`,
          })
          .pipe(
            Effect.map((response) => {
              const current = json(response, 200, "memory follow-up");
              if (current.status === "failed") {
                throw new Error(`Memory follow-up failed: ${response.body}`);
              }
              return current.status === "completed" ? current : undefined;
            }),
          ),
      );
      if (!config.privilegedPlatformCredential) {
        throw new Error("Active-recall E2E requires the confidential identity client credential.");
      }
      const runToken = config.privilegedPlatformCredential;
      const runAuth = tenantHeaders(runToken, config);
      const recall = yield* eventually(
        { label: `active recall ${runId}`, timeoutMs: 120_000 },
        http
          .request({
            body: { query: marker, runId, topK: 20 },
            headers: runAuth,
            method: "POST",
            path: "/v1/memory/active-recall",
          })
          .pipe(
            Effect.map((response) =>
              response.status === 504 ? undefined : json(response, 200, "active recall"),
            ),
          ),
      );
      const recalledIds = searchMemoryIds(recall);
      expect(recalledIds.has(memoryIds[0]!)).toBe(true);
      const retrieval = records(recall.retrievals ?? [], "active recall.retrievals")
        .map((item) => dataRecord(item, "active recall retrieval"))
        .find((item) => item.memoryId === memoryIds[0]);
      expect(retrieval).toBeDefined();
      const retrievalId = stringField(retrieval!, "id", "active recall retrieval");
      const qualitySince = new Date(Date.now() - 10 * 60_000).toISOString();
      const qualityBeforeFeedback = json(
        yield* http.request({
          headers: auth,
          method: "GET",
          path: `/v1/memory/quality?since=${encodeURIComponent(qualitySince)}`,
        }),
        200,
        "memory quality before feedback",
      );
      const usefulBeforeFeedback = usefulCount(
        qualityBeforeFeedback,
        "memory quality before feedback",
      );
      const feedback = json(
        yield* http.request({
          body: { feedback: "E2E active recall proof", usefulness: "useful" },
          headers: { ...auth, "idempotency-key": `${runKey}:feedback` },
          method: "POST",
          path: `/v1/memory/${memoryIds[0]}/retrievals/${retrievalId}/feedback`,
        }),
        200,
        "retrieval feedback",
      );
      expect(dataRecord(feedback, "retrieval feedback")).toMatchObject({ usefulness: "useful" });
      yield* eventually(
        { label: `quality feedback ${retrievalId}`, timeoutMs: 120_000 },
        http
          .request({
            headers: auth,
            method: "GET",
            path: `/v1/memory/quality?since=${encodeURIComponent(qualitySince)}`,
          })
          .pipe(
            Effect.map((response) => {
              const quality = json(response, 200, "memory quality after feedback");
              return usefulCount(quality, "memory quality after feedback") > usefulBeforeFeedback
                ? quality
                : undefined;
            }),
          ),
      );

      const beforeFlush = json(
        yield* http.request({
          headers: auth,
          method: "GET",
          path: `/v1/memory?space=${spaceId}&limit=20`,
        }),
        200,
        "memory before flush",
      );
      const beforeIds = new Set(
        records(beforeFlush.items ?? [], "memory before flush.items").map((item, index) =>
          stringField(
            dataRecord(item, `memory before[${index}]`),
            "id",
            `memory before[${index}].data`,
          ),
        ),
      );
      json(
        yield* http.request({
          body: { memoryMode: "organization", memorySpaceId: spaceId, runId },
          headers: { ...runAuth, "idempotency-key": `${runKey}:flush` },
          method: "POST",
          path: "/v1/memory/flushes",
        }),
        202,
        "memory flush enqueue",
      );
      const flush = yield* eventually(
        { label: `memory flush ${runId}`, timeoutMs: 240_000 },
        http.request({ headers: runAuth, method: "GET", path: `/v1/memory/flushes/${runId}` }).pipe(
          Effect.map((response) => {
            const current = dataRecord(json(response, 200, "memory flush"), "memory flush");
            if (current.status === "failed")
              throw new Error(`Memory flush failed: ${response.body}`);
            return current.status === "succeeded" ? current : undefined;
          }),
        ),
      );
      expect(Number(flush.candidateCount)).toBeGreaterThan(0);
      const flushMemoryIds = Array.isArray(flush.memoryIds)
        ? flush.memoryIds.filter((value): value is string => typeof value === "string")
        : [];
      expect(flushMemoryIds.length).toBeGreaterThan(0);

      for (const memoryId of new Set([
        memoryIds[0]!,
        ...flushMemoryIds.filter((id) => !beforeIds.has(id)),
      ])) {
        yield* cleanupMemoryHttpRequests(
          `memory ${memoryId}`,
          http.request({
            headers: { ...auth, "idempotency-key": `${runKey}:cleanup:archive:${memoryId}` },
            method: "POST",
            path: `/v1/memory/${memoryId}/archive`,
          }),
          http.request({
            body: { reason: "E2E cleanup" },
            headers: { ...auth, "idempotency-key": `${runKey}:cleanup:delete:${memoryId}` },
            method: "POST",
            path: `/v1/memory/${memoryId}/delete`,
          }),
        );
      }
    }).pipe(Effect.provide(CliProcessLive), Effect.provide(httpClientLayer(e2eApiUrl()))),
  900_000,
);
