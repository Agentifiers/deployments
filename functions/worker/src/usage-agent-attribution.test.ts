import { RunLocatorRecord, withCanonicalRecordKeys, type PlatformRecord } from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { boundFixture } from "./agent-run-bound.fixture.ts";
import { id, inMemoryDatabase } from "./agent-run.fixture.ts";
import { runtimeUsageRecord } from "./records.ts";
import { createMeterEventAgentResolver } from "./usage-agent-attribution.ts";

type Run = ReturnType<typeof boundFixture>["run"];

function locatorOf(run: Run) {
  return Schema.decodeUnknownSync(RunLocatorRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: run.data.createdAt,
        environmentId: run.data.environmentId,
        id: run.data.id,
        organizationId: run.data.organizationId,
        projectId: run.data.projectId,
        runPk: run.pk,
        runSk: run.sk,
      },
      itemType: "run-locator",
    }),
  );
}

function workerTime(run: Run) {
  return runtimeUsageRecord({
    entry: {
      idempotencyKey: "worker-ms",
      occurredAt: "2026-07-22T00:00:04.000Z",
      quantity: 1_200,
      runId: run.data.id,
      source: "agent-runtime",
      type: "worker_ms",
      unit: "ms",
    },
    id: id(90),
    run,
  });
}

function resolverOver(records: readonly PlatformRecord[]) {
  return createMeterEventAgentResolver(inMemoryDatabase(records).database);
}

describe("meter event agent attribution", () => {
  test("an evaluation run of a released agent keeps its agent after the binding expires", async () => {
    const { release, run } = boundFixture({
      purpose: "evaluation",
      source: "release",
      toolPolicy: "evaluation",
    });
    // The binding's TTL has removed it; the run still pins the release.
    const resolve = resolverOver([run, locatorOf(run), release]);

    expect(await resolve(workerTime(run))).toBe(release.data.agentDefinitionId);
  });

  test("a preview of an unpublished manifest belongs to no agent", async () => {
    const { binding, run } = boundFixture({
      purpose: "preview",
      source: "manifest",
      toolPolicy: "interactive",
    });
    const resolve = resolverOver([run, locatorOf(run), binding]);

    expect(await resolve(workerTime(run))).toBeUndefined();
  });

  test("usage outside runs belongs to no agent", async () => {
    const { run } = boundFixture({
      purpose: "preview",
      source: "release",
      toolPolicy: "interactive",
    });
    const { runId: _runId, ...data } = workerTime(run).data;

    expect(await resolverOver([])({ ...workerTime(run), data })).toBeUndefined();
  });
});
