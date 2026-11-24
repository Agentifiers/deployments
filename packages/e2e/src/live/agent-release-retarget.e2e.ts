import { expect, it } from "@effect/vitest";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { CliProcess, CliProcessLive } from "../harness/cli-process.ts";
import { eventually } from "../harness/eventually.ts";
import { E2eHttpClient, httpClientLayer } from "../harness/http-client.ts";
import {
  acquireRuntimeCredential,
  cleanupHttpRequest,
  cleanupMemoryHttpRequests,
  record,
  redactionSafeRandomId,
  stringField,
} from "../harness/live-agent.ts";
import { credentialedE2eEnabled, e2eApiUrl, scopedE2eConfig } from "../harness/live-config.ts";
import { tenantHeaders } from "../harness/platform-credential.ts";
import {
  acquireAgentDefinition,
  acquireDeployment,
  approveUntilComplete,
  awaitPendingApproval,
  awaitRunStatus,
  completeTurn,
  expectJson,
  jsonRecords,
  listRunIds,
  mutateDeployment,
  readRun,
  releaseManifest,
  searchRunIds,
  submitTurn,
} from "./agent-release-lifecycle-support.ts";

const enabled = credentialedE2eEnabled();

it.effect.skipIf(!enabled)(
  "retargets a deployment while an approval-paused run finishes on its original release",
  () =>
    Effect.gen(function* () {
      const config = yield* scopedE2eConfig;
      const cli = yield* CliProcess;
      const http = yield* E2eHttpClient;
      const runKey = `e2e-retarget-${randomUUID()}`;
      const marker = `retarget-memory-${redactionSafeRandomId()}`;
      const tenant = { auth: tenantHeaders(config.platformCredential, config), http, runKey };
      const { runtimeApiKey } = yield* acquireRuntimeCredential(cli, config, runKey);
      const runtime = { auth: tenantHeaders(runtimeApiKey, config), http, runKey };

      const space = record(
        expectJson(
          yield* http.request({
            body: { kind: "organization", name: `Retarget ${runKey}`, retentionDays: 1 },
            headers: { ...tenant.auth, "idempotency-key": `${runKey}:space` },
            method: "POST",
            path: "/v1/memory-spaces",
          }),
          201,
          "memory space create",
        ).data,
        "memory space.data",
      );
      const spaceId = stringField(space, "id", "memory space");
      yield* Effect.addFinalizer(() =>
        cleanupHttpRequest(
          "memory space",
          http.request({
            headers: { ...tenant.auth, "idempotency-key": `${runKey}:space:archive` },
            method: "DELETE",
            path: `/v1/memory-spaces/${spaceId}`,
          }),
        ).pipe(Effect.orDie),
      );

      const gatedManifest = releaseManifest(
        runKey,
        "After the release-pinned tool result, confirm completion in plain text.",
        {
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
          memory: { mode: "organization" },
          runtime: {
            toolRequests: [
              {
                effect: "write",
                idempotencyKey: `${runKey}:memory-save`,
                input: { content: marker, memorySpaceId: spaceId, scope: "organization" },
                inputSummary: "E2E retarget requested agent.memory.save.",
                requiredScopes: [],
                toolName: "agent.memory.save",
              },
            ],
          },
        },
      );
      const agent = yield* acquireAgentDefinition(tenant, gatedManifest);
      const grant = record(
        expectJson(
          yield* http.request({
            body: {
              agentDefinitionId: agent.definitionId,
              memorySpaceId: spaceId,
              permission: "read-write",
            },
            headers: { ...tenant.auth, "idempotency-key": `${runKey}:grant` },
            method: "POST",
            path: "/v1/memory-space-grants",
          }),
          201,
          "memory grant create",
        ).data,
        "memory grant.data",
      );
      yield* Effect.addFinalizer(() =>
        cleanupHttpRequest(
          "memory grant",
          http.request({
            headers: { ...tenant.auth, "idempotency-key": `${runKey}:grant:revoke` },
            method: "DELETE",
            path: `/v1/memory-space-grants/${stringField(grant, "id", "memory grant")}`,
          }),
        ).pipe(Effect.orDie),
      );

      const releaseOne = yield* agent.publish("r1");
      const releaseOneId = stringField(releaseOne, "id", "r1");
      const deployment = yield* acquireDeployment(tenant, releaseOneId);
      const deploymentId = stringField(deployment, "id", "agent deployment");

      const runA = yield* submitTurn(runtime, deploymentId, "run-a");
      expect(runA.run.agentReleaseId).toBe(releaseOneId);
      const approval = yield* awaitPendingApproval(runtime, runA.runId);
      yield* awaitRunStatus(runtime, runA, "waiting-for-approval");

      const releaseTwo = yield* agent.publish(
        "r2",
        releaseManifest(runKey, "Reply with one short plain-text sentence; never call tools."),
      );
      const releaseTwoId = stringField(releaseTwo, "id", "r2");
      expect(releaseTwoId).not.toBe(releaseOneId);
      expect(releaseTwo.contentHash).not.toBe(releaseOne.contentHash);

      const retargeted = yield* mutateDeployment(tenant, deploymentId, {
        body: { agentReleaseId: releaseTwoId },
        label: "retarget",
        method: "PATCH",
      });
      expect(retargeted).toMatchObject({ agentReleaseId: releaseTwoId, id: deploymentId });

      const runB = yield* completeTurn(runtime, deploymentId, "run-b");
      expect(runB.turn.threadId).not.toBe(runA.threadId);
      expect(runB.turn.run.agentReleaseId).toBe(releaseTwoId);
      expect(runB.run.agentReleaseId).toBe(releaseTwoId);

      expect((yield* readRun(runtime, runA)).agentReleaseId).toBe(releaseOneId);
      const approved = yield* approveUntilComplete(
        runtime,
        runA,
        stringField(approval, "id", "approval"),
      );
      expect(approved.run).toMatchObject({ agentReleaseId: releaseOneId, status: "completed" });

      const releaseOneRuns = yield* listRunIds(runtime, deploymentId, releaseOneId);
      expect(releaseOneRuns).toContain(runA.runId);
      expect(releaseOneRuns).not.toContain(runB.turn.runId);
      const releaseTwoRuns = yield* searchRunIds(runtime, deploymentId, releaseTwoId);
      expect(releaseTwoRuns).toContain(runB.turn.runId);
      expect(releaseTwoRuns).not.toContain(runA.runId);

      const savedMemories = yield* eventually(
        { label: `durable retarget memories for ${runA.runId}`, timeoutMs: 180_000 },
        http
          .request({
            headers: tenant.auth,
            method: "GET",
            path: `/v1/memory?space=${spaceId}&limit=20`,
          })
          .pipe(
            Effect.map((response) => {
              const memories = jsonRecords(
                expectJson(response, 200, "saved memories").items ?? [],
                "saved memories.items",
              )
                .map((item) => record(item.data, "saved memory.data"))
                .filter((memory) => memory.sourceRunId === runA.runId);
              return memories.length >= approved.approvals ? memories : undefined;
            }),
          ),
      );
      for (const memory of savedMemories) {
        const memoryId = stringField(memory, "id", "saved memory");
        yield* cleanupMemoryHttpRequests(
          `retarget memory ${memoryId}`,
          http.request({
            headers: { ...tenant.auth, "idempotency-key": `${runKey}:memory:archive:${memoryId}` },
            method: "POST",
            path: `/v1/memory/${memoryId}/archive`,
          }),
          http.request({
            body: { reason: "E2E cleanup" },
            headers: { ...tenant.auth, "idempotency-key": `${runKey}:memory:delete:${memoryId}` },
            method: "POST",
            path: `/v1/memory/${memoryId}/delete`,
          }),
        );
      }
    }).pipe(Effect.provide(CliProcessLive), Effect.provide(httpClientLayer(e2eApiUrl()))),
  600_000,
);
