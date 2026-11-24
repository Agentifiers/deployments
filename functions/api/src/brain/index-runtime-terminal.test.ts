import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import {
  BrainExtractionLimitError,
  BrainIndexStaleError,
  type Brain,
  type BrainDocument,
  type BrainDocumentRendition,
  type BrainDocumentVersion,
  type BrainRepository,
  type BrainSearchProviderClient,
  type BrainSource,
} from "@deployments-ai/brains";
import {
  BRAIN_INDEX_BRAIN_INACTIVE,
  BRAIN_INDEX_MAX_ATTEMPTS,
  BRAIN_INDEX_RETRIES_EXHAUSTED,
  BrainIndexJobRecord,
  BrainSearchPlacementRecord,
  brainDocumentPlatformRecord,
  brainPlatformRecord,
  brainSourcePlatformRecord,
  brainUlid,
  claimBrainProviderMutation,
  getBrainIndexJob,
  makeBrainDynamoRepository,
  makeDynamoDatabase,
  withCanonicalRecordKeys,
  type BrainIndexJob,
} from "@deployments-ai/db";
import { fakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import { Schema } from "effect";
import { dispatchDueBrainIndexJobs } from "./index-dispatcher-main.ts";
import { processBrainIndexMessage, type BrainIndexRuntimeDependencies } from "./index-runtime.ts";
import { handleBrainIndexQueue } from "./index-worker-main.ts";

const organizationId = "01ARZ3NDEKTSV4RRFFQ69G6006";
const brainId = "01M403FMNP7S2YVJ5Y67R3J87H";
const sourceId = "01M403FPPFMKRZF7PJ210Y070N";
const documentId = "01M403FR0Z4VNNQWM841K3XHP7";
const versionId = "01M403FPZ6T94GBCFS3W9HSAWC";
const targetId = "01M12QGESQ6N0M4ZT1H6M5CYZS";
const profileId = "01ARZ3NDEKTSV4RRFFQ69G6001";
const principalId = "01KYK5W3M7Z4KR6VP8BJTA8ACF";
const createdAt = "2026-10-03T05:23:44.287Z";
const now = new Date("2026-10-03T06:00:00.000Z");
const message = { documentId, idempotencyKey: `${documentId}:0:index`, organizationId };
const queueUrl = "https://sqs.example/brain-index.fifo";

const target = {
  components: (["dense", "entity", "exact", "lexical"] as const).map((kind, index) => ({
    componentId: `01M12QGESQ6N0M4ZT1H6M5CYZ${"NPQR"[index]}`,
    kind,
  })),
  embeddingProfileId: profileId,
  location: { openSearchIndex: "brain-test" },
  providerId: "aws-native" as const,
  schemaGeneration: 1,
  targetId,
};

function brain(status: Brain["status"]): Brain {
  return {
    createdAt,
    createdByPrincipalId: principalId,
    id: brainId,
    kind: "company",
    maintenancePolicy: {},
    name: "E2E Brain",
    organizationId,
    ownershipGeneration: 0,
    retrievalPolicy: {},
    schemaVersion: 1,
    sensitivity: "internal",
    slug: "e2e-brain",
    status,
    updatedAt: createdAt,
    updatedByPrincipalId: principalId,
    version: 1,
  };
}

const document: BrainDocument = {
  brainId,
  createdAt,
  currentContentVersionId: versionId,
  currentEnvelopeHash: "envelope",
  currentSourceOrder: 1,
  currentVersionId: versionId,
  externalItemIdentity: "decision",
  id: documentId,
  lifecycle: "active",
  organizationId,
  projectionGeneration: 0,
  reviewStatus: "approved",
  sensitivity: "internal",
  sourceId,
  updatedAt: createdAt,
  version: 1,
};

const source: BrainSource = {
  brainId,
  createdAt,
  createdByPrincipalId: principalId,
  id: sourceId,
  kind: "upload",
  name: "Uploads",
  organizationId,
  status: "active",
  updatedAt: createdAt,
  updatedByPrincipalId: principalId,
  version: 0,
};

const version: BrainDocumentVersion = {
  brainId,
  byteSize: 5,
  contentHash: "sha256:content",
  createdAt,
  documentId,
  envelopeHash: "envelope",
  id: versionId,
  kind: "content",
  mediaType: "text/plain",
  organizationId,
  originalRenditionId: "01M403FR0Z4VNNQWM841K3XHPA",
  sourceId,
  sourceOrder: 1,
};

const rendition: BrainDocumentRendition = {
  bodyRef: {
    bucket: "content",
    byteSize: 5,
    contentType: "text/plain",
    key: "organizations/org/brains/brain/original",
    sha256: "sha256:content",
    versionId: "s3-version",
  },
  brainId,
  contentHash: "sha256:content",
  coordinateSystem: "utf8-byte",
  createdAt,
  documentId,
  documentVersionId: versionId,
  id: "01M403FR0Z4VNNQWM841K3XHPA",
  kind: "original",
  organizationId,
};

const overTokenLimit = { bytes: new Uint8Array(750_001).fill(0x61), mediaType: "text/plain" };
const failedComponents = (["dense", "entity", "exact", "lexical"] as const).map((kind) => ({
  kind,
  status: "failed" as const,
  updatedAt: now.toISOString(),
}));
const textIsNeverExtracted = () =>
  Promise.reject(new Error("Text versions are read directly, never extracted."));

function job(data: Partial<BrainIndexJob["data"]> = {}): BrainIndexJob {
  return Schema.decodeUnknownSync(BrainIndexJobRecord)(
    withCanonicalRecordKeys({
      data: {
        attempt: 0,
        brainId,
        components: target.components.map((component) => ({
          ...component,
          status: "pending" as const,
        })),
        createdAt,
        documentId,
        documentVersionId: versionId,
        embeddingProfileId: profileId,
        expectedProjectionGeneration: 0,
        id: "01M403FR0Z4VNNQWM841K3XHP9",
        idempotencyKey: message.idempotencyKey,
        nextDueAt: "2026-10-03T05:39:05.994Z",
        operation: "index" as const,
        organizationId,
        placementGeneration: 1,
        priority: 100,
        provider: "aws-native" as const,
        renditionId: "01M403FR0Z4VNNQWM841K3XHPA",
        schemaGeneration: 1,
        sourceId,
        status: "queued" as const,
        targetId,
        updatedAt: createdAt,
        version: 0,
        ...data,
      },
      itemType: "brain-index-job" as const,
    }),
  );
}

const readyProvider: BrainSearchProviderClient = {
  capabilities: { components: ["dense", "entity", "exact", "lexical"], hybrid: true },
  deleteDocument: async () => ({ deleted: true }),
  inspect: async () => ({ components: [], ready: true }),
  prepare: async () => undefined,
  providerId: "aws-native",
  purgeBrain: async () => ({ deleted: true, receipt: {} }),
  purgeOrganization: async () => ({ deleted: true, receipt: {} }),
  search: async () => [],
  target,
  upsert: async ({ chunks }) => ({
    components: (["dense", "entity", "exact", "lexical"] as const).map((kind) => ({
      kind,
      ready: true,
    })),
    written: chunks.length,
  }),
};

async function harness(input: {
  readonly brainStatus: Brain["status"];
  readonly content?: { readonly bytes: Uint8Array; readonly mediaType: string };
  readonly job: BrainIndexJob;
  readonly repositoryBrainStatus?: Brain["status"];
  readonly resolve?: () => Promise<BrainSearchProviderClient>;
  readonly sourceStatus?: BrainSource["status"];
}) {
  const content = input.content ?? {
    bytes: new TextEncoder().encode("hello"),
    mediaType: "text/plain",
  };
  const dynamo = fakeDynamoDocumentClient();
  const database = makeDynamoDatabase(dynamo.client);
  dynamo.put(
    "control",
    withCanonicalRecordKeys({
      data: {
        createdAt,
        id: organizationId,
        name: "Deployments.ai",
        slug: "deployments-ai",
        status: "active",
        updatedAt: createdAt,
        version: 1,
      },
      itemType: "organization" as const,
    }),
  );
  dynamo.put("control", brainPlatformRecord(brain(input.brainStatus)));
  dynamo.put("control", brainDocumentPlatformRecord(document));
  dynamo.put(
    "control",
    brainSourcePlatformRecord({ ...source, status: input.sourceStatus ?? "active" }),
  );
  await database.transactWrite([
    {
      kind: "put",
      record: Schema.decodeUnknownSync(BrainSearchPlacementRecord)(
        withCanonicalRecordKeys({
          data: {
            createdAt,
            generation: 1,
            organizationId,
            phase: "active" as const,
            readTarget: target,
            updatedAt: createdAt,
            version: 1,
            writeTarget: target,
          },
          itemType: "brain-search-placement" as const,
        }),
      ),
    },
    { kind: "put", record: input.job },
  ]);
  const repository = {
    get: async () => brain(input.repositoryBrainStatus ?? input.brainStatus),
    getDocument: async () => document,
    getDocumentRendition: async () => rendition,
    getDocumentVersion: async () => ({ ...version, mediaType: content.mediaType }),
    getSource: async () => ({ ...source, status: input.sourceStatus ?? "active" }),
  } as unknown as BrainRepository;
  const clock = { now };
  const dependencies: BrainIndexRuntimeDependencies = {
    database,
    embeddings: () => ({ embed: async () => [1, 0] }),
    extractor: { extract: textIsNeverExtracted },
    loadRendition: async () => content.bytes,
    now: () => clock.now,
    providers: { resolve: input.resolve ?? (async () => readyProvider) },
    repository,
    textRenditionStore: { presign: textIsNeverExtracted, putOnce: textIsNeverExtracted },
    workerId: "worker-1",
  };
  const run = () => processBrainIndexMessage(message, dependencies);
  const dispatched = async (at = now) => {
    const commands: SendMessageBatchCommand[] = [];
    await dispatchDueBrainIndexJobs(database, at, {
      send: async (command) => {
        commands.push(command as unknown as SendMessageBatchCommand);
        return {} as never;
      },
    });
    return commands.flatMap((command) =>
      (command.input.Entries ?? []).map((entry) => JSON.parse(entry.MessageBody!)),
    );
  };
  const claimForNextVersion = async () => {
    const next = job({
      attempt: 1,
      expectedProjectionGeneration: 1,
      id: brainUlid("01M403FR0Z4VNNQWM841K3XHPB"),
      idempotencyKey: `${documentId}:1:index`,
      leaseExpiresAt: "2026-10-03T06:10:00.000Z",
      leaseOwner: "worker-2",
      status: "running",
    });
    dynamo.put("control", brainDocumentPlatformRecord({ ...document, projectionGeneration: 1 }));
    await database.transactWrite([{ kind: "put", record: next }]);
    return claimBrainProviderMutation({
      database,
      job: next,
      leaseExpiresAt: "2026-10-03T06:10:00.000Z",
      leaseOwner: "worker-2",
      now: "2026-10-03T06:00:00.000Z",
    });
  };
  return {
    claimForNextVersion,
    clock,
    current: () => getBrainIndexJob(database, message),
    dependencies,
    dispatched,
    health: async () =>
      (
        await makeBrainDynamoRepository(database).listIndexHealth(organizationId, brainId, {
          limit: 10,
        })
      ).items,
    run,
  };
}

describe("Brain index jobs end instead of looping", () => {
  let previousQueueUrl: string | undefined;
  beforeEach(() => {
    previousQueueUrl = process.env.DEPLOYMENTS_AI_BRAIN_INDEX_QUEUE_URL;
    process.env.DEPLOYMENTS_AI_BRAIN_INDEX_QUEUE_URL = queueUrl;
  });
  afterEach(() => {
    if (previousQueueUrl === undefined) delete process.env.DEPLOYMENTS_AI_BRAIN_INDEX_QUEUE_URL;
    else process.env.DEPLOYMENTS_AI_BRAIN_INDEX_QUEUE_URL = previousQueueUrl;
  });

  test("retires a queued job whose Brain was archived and never redispatches it", async () => {
    const value = await harness({
      brainStatus: "archived",
      job: job({ attempt: 2, version: 6 }),
    });
    expect(await value.dispatched()).toEqual([message]);

    expect(value.run()).resolves.toEqual({ outcome: "brain-inactive" });

    expect((await value.current())?.data).toMatchObject({
      skipReason: BRAIN_INDEX_BRAIN_INACTIVE,
      status: "succeeded",
      version: 7,
    });
    expect(await value.dispatched(new Date("2026-10-04T00:00:00.000Z"))).toEqual([]);
    expect(value.run()).resolves.toEqual({ outcome: "ignored" });
  });

  test("retires a job whose Brain is archived while it is being indexed", async () => {
    const value = await harness({
      brainStatus: "active",
      job: job(),
      repositoryBrainStatus: "archived",
    });

    expect(value.run()).resolves.toEqual({ outcome: "stale" });

    expect((await value.current())?.data).toMatchObject({ status: "succeeded", version: 2 });
    expect((await value.current())?.data.skipReason).toBe(new BrainIndexStaleError().message);
    expect(await value.dispatched(new Date("2026-10-04T00:00:00.000Z"))).toEqual([]);
  });

  test("retries staleness a later attempt can still resolve", async () => {
    const value = await harness({ brainStatus: "active", job: job(), sourceStatus: "paused" });

    expect(value.run()).rejects.toBeInstanceOf(BrainIndexStaleError);

    const failed = await value.current();
    expect(failed?.data).toMatchObject({ attempt: 1, status: "failed" });
    expect(failed?.data).not.toHaveProperty("skipReason");
    expect(await value.dispatched(new Date(failed!.data.nextDueAt!))).toEqual([message]);
  });

  test("defers a message that arrives before its job's retry is due until the retry", async () => {
    const nextDueAt = "2026-10-03T06:30:00.000Z";
    const value = await harness({
      brainStatus: "active",
      job: job({ attempt: 3, error: "provider unavailable", nextDueAt, status: "failed" }),
    });

    expect(value.run()).resolves.toEqual({ outcome: "deferred", retryAt: nextDueAt });

    expect((await value.current())?.data).toMatchObject({ status: "failed", version: 0 });
    expect(await value.dispatched()).toEqual([]);
    expect(await value.dispatched(new Date(nextDueAt))).toEqual([message]);
  });

  test("holds a deferred message only for a retry due within five minutes", async () => {
    const delivered = async (nextDueAt: string) => {
      const value = await harness({
        brainStatus: "active",
        job: job({ attempt: 9, error: "provider unavailable", nextDueAt, status: "failed" }),
      });
      const held: number[] = [];
      const { batchItemFailures } = await handleBrainIndexQueue(
        {
          Records: [
            {
              attributes: { ApproximateReceiveCount: "1" },
              body: JSON.stringify(message),
              messageId: "message-1",
              receiptHandle: "receipt-1",
            },
          ],
        },
        value.dependencies,
        {
          changeVisibility: async (_receiptHandle, seconds) => {
            held.push(seconds);
          },
          random: () => 1,
        },
      );
      return {
        batchItemFailures,
        dispatchedWhenDue: await value.dispatched(new Date(nextDueAt)),
        held,
      };
    };

    expect(await delivered("2026-10-03T06:05:00.000Z")).toEqual({
      batchItemFailures: [{ itemIdentifier: "message-1" }],
      dispatchedWhenDue: [message],
      held: [300],
    });
    expect(await delivered("2026-10-03T06:42:40.000Z")).toEqual({
      batchItemFailures: [],
      dispatchedWhenDue: [message],
      held: [],
    });
  });

  test("fails terminally after its last attempt and drops out of dispatch", async () => {
    const value = await harness({
      brainStatus: "active",
      job: job({ attempt: BRAIN_INDEX_MAX_ATTEMPTS - 1 }),
      resolve: async () => {
        throw new Error("Pinned model route identity is not canonical.");
      },
    });

    expect(value.run()).rejects.toThrow("Pinned model route identity");

    const failed = await value.current();
    expect(failed?.data).toMatchObject({
      attempt: BRAIN_INDEX_MAX_ATTEMPTS,
      skipReason: BRAIN_INDEX_RETRIES_EXHAUSTED,
      status: "failed",
    });
    expect(failed?.data).not.toHaveProperty("nextDueAt");
    expect(await value.dispatched(new Date("2026-10-04T00:00:00.000Z"))).toEqual([]);
    expect(value.run()).resolves.toEqual({ outcome: "ignored" });
    expect(await value.health()).toEqual([
      {
        components: failedComponents,
        documentId,
        documentVersionId: versionId,
        lastError: "Pinned model route identity is not canonical.",
        projectionGeneration: 0,
        status: "failed",
        updatedAt: "2026-10-03T06:00:00.000Z",
      },
    ]);
  });

  test("ends a document over the token limit on its first attempt and shows it in index health", async () => {
    const value = await harness({ brainStatus: "active", content: overTokenLimit, job: job() });

    expect(value.run()).rejects.toThrow("Brain extraction exceeded token limit.");

    const failed = await value.current();
    expect(failed?.data).toMatchObject({
      attempt: 1,
      skipReason: "permanent-failure",
      status: "failed",
    });
    expect(failed?.data).not.toHaveProperty("nextDueAt");
    expect(await value.dispatched(new Date("2026-10-04T00:00:00.000Z"))).toEqual([]);
    expect(await value.health()).toEqual([
      {
        components: failedComponents,
        documentId,
        documentVersionId: versionId,
        lastError: "Brain extraction exceeded token limit.",
        projectionGeneration: 0,
        status: "failed",
        updatedAt: "2026-10-03T06:00:00.000Z",
      },
    ]);
  });

  test("frees the document for its next version after a permanent failure", async () => {
    const value = await harness({ brainStatus: "active", content: overTokenLimit, job: job() });
    expect(value.run()).rejects.toThrow("token limit");

    expect(await value.claimForNextVersion()).toMatchObject({ outcome: "claimed" });
  });

  test("retries a content-looking failure raised after the provider write and keeps its claim", async () => {
    const written: string[][] = [];
    const value = await harness({
      brainStatus: "active",
      job: job(),
      resolve: async () => ({
        ...readyProvider,
        upsert: async ({ chunks }) => {
          written.push(chunks.map((chunk) => chunk.chunkId));
          throw new BrainExtractionLimitError("chunk count limit");
        },
      }),
    });

    expect(value.run()).rejects.toThrow("Brain extraction exceeded chunk count limit.");

    expect(written).toEqual([[`${versionId}:0:0:0-5`]]);
    const failed = await value.current();
    expect(failed?.data).toMatchObject({
      attempt: 1,
      nextDueAt: "2026-10-03T06:00:10.000Z",
      status: "failed",
    });
    expect(failed?.data).not.toHaveProperty("skipReason");
    expect(await value.claimForNextVersion()).toMatchObject({ outcome: "busy" });
  });
});

describe("Brain index queue redelivery", () => {
  const QUEUE_VISIBILITY_TIMEOUT_SECONDS = 900;

  async function indexOneDocument(failingResolves: number) {
    let failures = failingResolves;
    const value = await harness({
      brainStatus: "active",
      job: job(),
      resolve: async () => {
        if (failures > 0) {
          failures -= 1;
          throw new Error("TransactionConflict");
        }
        return readyProvider;
      },
    });
    const receivedAtSeconds: number[] = [];
    let visibleAt = now.getTime();
    for (let receiveCount = 1; receiveCount <= 10; receiveCount += 1) {
      value.clock.now = new Date(visibleAt);
      receivedAtSeconds.push((visibleAt - now.getTime()) / 1_000);
      let visibilitySeconds = QUEUE_VISIBILITY_TIMEOUT_SECONDS;
      const { batchItemFailures } = await handleBrainIndexQueue(
        {
          Records: [
            {
              attributes: { ApproximateReceiveCount: String(receiveCount) },
              body: JSON.stringify(message),
              messageId: "message-1",
              receiptHandle: `receipt-${receiveCount}`,
            },
          ],
        },
        value.dependencies,
        {
          changeVisibility: async (receiptHandle, seconds) => {
            expect(receiptHandle).toBe(`receipt-${receiveCount}`);
            visibilitySeconds = seconds;
          },
          random: () => 1,
        },
      );
      if (batchItemFailures.length === 0) break;
      visibleAt += visibilitySeconds * 1_000;
    }
    return { jobStatus: (await value.current())?.data.status, receivedAtSeconds };
  }

  test("retries a failed index attempt within seconds instead of the queue visibility timeout", async () => {
    expect(await indexOneDocument(1)).toEqual({
      jobStatus: "succeeded",
      receivedAtSeconds: [0, 2, 10],
    });
  });

  test("keeps a job whose retry is not yet due on the queue until it is due", async () => {
    expect(await indexOneDocument(2)).toEqual({
      jobStatus: "succeeded",
      receivedAtSeconds: [0, 2, 10, 18, 30],
    });
  });
});
