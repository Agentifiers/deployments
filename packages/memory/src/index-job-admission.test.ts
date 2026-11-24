import { describe, expect, it } from "bun:test";
import {
  makeDynamoDatabase,
  MemoryProviderMutationGateRecord,
  withCanonicalRecordKeys,
  type Ulid,
} from "@deployments-ai/db";
import { fakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import { Schema } from "effect";
import { makeMemoryPlatform } from "./platform.ts";
import { memoryProviderMutationClaimKey } from "./placement.ts";
import { fakeMemorySearchProvider } from "./memory-search-test-fixtures.ts";
import type { MemorySearchTarget } from "./provider.ts";
import { ids, memoryFixture } from "./test-fixtures.ts";

const fixedNow = new Date("2026-08-29T07:08:26.071Z");
const scope = {
  environmentId: ids.environment,
  organizationId: ids.organization,
  projectId: ids.project,
  workspaceId: ids.workspace,
};

const unreachable = async (): Promise<never> => {
  throw new Error("Index admission must not reach the search provider.");
};
const searchProvider = fakeMemorySearchProvider({
  delete: unreachable,
  query: unreachable,
  synchronizeLifecycle: unreachable,
  write: unreachable,
}).provider;

function routedTarget(targetId: Ulid): MemorySearchTarget {
  return {
    componentIds: [ids.space],
    embeddingProfileId: ids.agent,
    location: { region: "us-east-2" },
    providerId: "aws-native",
    schemaGeneration: 3,
    targetId,
  };
}

/**
 * Queues an index job through a platform without durable routing (a legacy static search target),
 * then returns a durably routed platform over the same condition-enforcing DynamoDB tables.
 */
async function unadmittedJob(routedTargetId?: (legacyTargetId: Ulid) => Ulid) {
  const dynamo = fakeDynamoDocumentClient();
  const database = makeDynamoDatabase(dynamo.client);
  const memory = memoryFixture();
  dynamo.put(
    "control",
    withCanonicalRecordKeys({
      data: {
        createdAt: fixedNow.toISOString(),
        id: ids.organization,
        name: "Memory Admission",
        slug: "memory-admission",
        status: "active",
        updatedAt: fixedNow.toISOString(),
        version: 1,
      },
      itemType: "organization",
    }),
  );
  dynamo.put("control", memory);
  const embedding = async (): Promise<never> => {
    throw new Error("Index admission must not embed.");
  };
  const queued = await makeMemoryPlatform({
    database,
    embedding,
    now: () => fixedNow,
    searchProvider,
  }).enqueueIndexJob({ memory, scope, synchronizationGeneration: 7 });
  const legacyTargetId = queued.data.targetId!;
  const target = routedTarget(routedTargetId ? routedTargetId(legacyTargetId) : ids.run);
  dynamo.put(
    "control",
    Schema.decodeUnknownSync(MemoryProviderMutationGateRecord)(
      withCanonicalRecordKeys({
        data: {
          createdAt: fixedNow.toISOString(),
          drainEpoch: 0,
          organizationId: ids.organization,
          status: "open" as const,
          targetId: target.targetId,
          updatedAt: fixedNow.toISOString(),
          version: 0,
        },
        itemType: "memory-provider-mutation-gate" as const,
      }),
    ),
  );
  const platform = makeMemoryPlatform({
    database,
    embedding,
    now: () => new Date(fixedNow.getTime() + 60_000),
    searchRoutingResolver: async () => ({
      fenceEpoch: 1,
      fenceVersion: 1,
      placementGeneration: 4,
      placementPhase: "active",
      placementVersion: 5,
      read: { providerId: target.providerId, target },
      writes: [{ providerId: target.providerId, target }],
    }),
    searchProvider,
  });
  const admissionKey = memoryProviderMutationClaimKey(
    ids.organization,
    legacyTargetId,
    `index-job:${queued.data.id}`,
  );
  return { admissionKey, dynamo, legacyTargetId, platform, queued };
}

describe("memory index job admission", () => {
  it("terminalizes a queued job whose unadmitted target is no longer routed", async () => {
    const { admissionKey, dynamo, legacyTargetId, platform, queued } = await unadmittedJob();
    expect(dynamo.get("control", admissionKey)).toBeUndefined();

    const processed = await platform.processIndexJob(scope, {
      idempotencyKey: queued.data.idempotencyKey,
      memoryId: queued.data.memoryId,
      targetId: legacyTargetId,
    });

    expect(processed.data).toMatchObject({
      attempt: 0,
      skipReason: "retired-search-target",
      status: "succeeded",
      version: queued.data.version + 1,
    });
    expect(processed.data).not.toHaveProperty("nextDueAt");
    expect(dynamo.get("execution", { pk: queued.pk, sk: queued.sk })).toMatchObject({
      data: { skipReason: "retired-search-target", status: "succeeded" },
    });
    expect(dynamo.get("control", admissionKey)).toBeUndefined();
  });

  it("admits a queued job that never received an admission claim for a routed target", async () => {
    const { admissionKey, dynamo, legacyTargetId, platform, queued } = await unadmittedJob(
      (legacyTargetId) => legacyTargetId,
    );

    const running = await platform.claimIndexJob(
      scope,
      queued.data.memoryId,
      queued.data.idempotencyKey,
      "worker-1",
      legacyTargetId,
    );

    expect(running.data).toMatchObject({ attempt: 1, leaseOwner: "worker-1", status: "running" });
    expect(dynamo.get("control", admissionKey)).toMatchObject({
      data: { messageGroup: `index-job:${queued.data.id}`, status: "claimed" },
    });
    const completed = await platform.completeIndexJob(running);
    expect(completed.data.status).toBe("succeeded");
    expect(dynamo.get("control", admissionKey)).toBeUndefined();
  });
});
