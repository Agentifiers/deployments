import { describe, expect, test } from "bun:test";
import type {
  Brain,
  BrainDocument,
  BrainDocumentRendition,
  BrainDocumentVersion,
  BrainRepository,
  BrainSearchProviderClient,
  BrainSource,
} from "@deployments-ai/brains";
import {
  BrainIndexJobRecord,
  BrainSearchPlacementRecord,
  getBrainIndexJob,
  getBrainIndexState,
  tableForItemType,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TransactionOperation,
} from "@deployments-ai/db";
import { standingInstallation } from "@deployments-ai/organization-admission/testing";
import { Schema } from "effect";
import { processBrainIndexMessage } from "./index-runtime.ts";

const values = [
  "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  "01ARZ3NDEKTSV4RRFFQ69G5FAY",
  "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
  "01ARZ3NDEKTSV4RRFFQ69G5FB0",
  "01ARZ3NDEKTSV4RRFFQ69G5FB1",
  "01ARZ3NDEKTSV4RRFFQ69G5FB2",
  "01ARZ3NDEKTSV4RRFFQ69G5FB3",
  "01ARZ3NDEKTSV4RRFFQ69G5FB4",
  "01ARZ3NDEKTSV4RRFFQ69G5FB5",
  "01ARZ3NDEKTSV4RRFFQ69G5FB6",
] as const;
const [
  organizationId,
  brainId,
  sourceId,
  documentId,
  versionId,
  renditionId,
  profileId,
  targetId,
  jobId,
  denseId,
  lexicalId,
  exactId,
] = values;
const entityId = "01ARZ3NDEKTSV4RRFFQ69G5FB7";
const timestamp = "2026-07-30T12:00:00.000Z";
const idempotencyKey = `${documentId}:3:index`;
const textIsNeverExtracted = () =>
  Promise.reject(new Error("Text versions are read directly, never extracted."));
const textExtraction = {
  extractor: { extract: textIsNeverExtracted },
  textRenditionStore: { presign: textIsNeverExtracted, putOnce: textIsNeverExtracted },
};

function memoryDatabase(
  initial: readonly PlatformRecord[],
  standingDatabase?: DynamoDatabaseService,
) {
  const records = new Map(
    initial.map((record) => [
      `${tableForItemType(record.itemType)}|${record.pk}|${record.sk}`,
      record,
    ]),
  );
  const database: DynamoDatabaseService = {
    deleteRecord: async () => {},
    getRecord: async (table, key) =>
      records.get(`${table}|${key.pk}|${key.sk}`) ?? standingDatabase?.getRecord(table, key),
    putRecord: async (record) => {
      records.set(`${tableForItemType(record.itemType)}|${record.pk}|${record.sk}`, record);
    },
    queryRecords: () => Promise.resolve({ items: [] }),
    transactWrite: async (operations: readonly TransactionOperation[]) => {
      for (const operation of operations) {
        if (operation.kind === "condition-check") continue;
        const table = tableForItemType(operation.record.itemType);
        const storageKey = `${table}|${operation.record.pk}|${operation.record.sk}`;
        if (operation.kind === "delete") records.delete(storageKey);
        else records.set(storageKey, operation.record);
      }
    },
  };
  return { database, records };
}

function fixture() {
  const components = [
    { componentId: denseId, kind: "dense" as const },
    { componentId: lexicalId, kind: "lexical" as const },
    { componentId: exactId, kind: "exact" as const },
    { componentId: entityId, kind: "entity" as const },
  ];
  const target = {
    components,
    embeddingProfileId: profileId,
    location: { openSearchIndex: "brain-test" },
    providerId: "aws-native" as const,
    schemaGeneration: 1,
    targetId,
  };
  const placement = Schema.decodeUnknownSync(BrainSearchPlacementRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: timestamp,
        generation: 1,
        organizationId,
        phase: "active" as const,
        readTarget: target,
        updatedAt: timestamp,
        version: 1,
        writeTarget: target,
      },
      itemType: "brain-search-placement" as const,
    }),
  );
  const job = Schema.decodeUnknownSync(BrainIndexJobRecord)(
    withCanonicalRecordKeys({
      data: {
        attempt: 0,
        brainId,
        components: components.map((component) => ({ ...component, status: "pending" as const })),
        createdAt: timestamp,
        documentId,
        documentVersionId: versionId,
        embeddingProfileId: profileId,
        expectedContentHash: "sha256:content",
        expectedProjectionGeneration: 3,
        id: jobId,
        idempotencyKey,
        nextDueAt: timestamp,
        operation: "index" as const,
        organizationId,
        placementGeneration: 1,
        priority: 100,
        provider: "aws-native" as const,
        renditionId,
        schemaGeneration: 1,
        sourceId,
        status: "queued" as const,
        targetId,
        updatedAt: timestamp,
        version: 0,
      },
      itemType: "brain-index-job" as const,
    }),
  );
  const brain: Brain = {
    createdAt: timestamp,
    createdByPrincipalId: jobId,
    id: brainId,
    kind: "company",
    maintenancePolicy: {},
    name: "Engineering",
    organizationId,
    ownershipGeneration: 0,
    retrievalPolicy: {},
    schemaVersion: 1,
    sensitivity: "internal",
    slug: "engineering",
    status: "active",
    updatedAt: timestamp,
    updatedByPrincipalId: jobId,
    version: 0,
  };
  const document: BrainDocument = {
    brainId,
    createdAt: timestamp,
    currentContentVersionId: versionId,
    currentEnvelopeHash: "envelope",
    currentSourceOrder: 1,
    currentVersionId: versionId,
    externalItemIdentity: "decision",
    id: documentId,
    lifecycle: "active",
    organizationId,
    projectionGeneration: 3,
    reviewStatus: "approved",
    sensitivity: "internal",
    sourceId,
    updatedAt: timestamp,
    version: 2,
  };
  const source: BrainSource = {
    brainId,
    createdAt: timestamp,
    createdByPrincipalId: jobId,
    id: sourceId,
    kind: "upload",
    name: "Uploads",
    organizationId,
    status: "active",
    updatedAt: timestamp,
    updatedByPrincipalId: jobId,
    version: 0,
  };
  const version: BrainDocumentVersion = {
    brainId,
    byteSize: 5,
    contentHash: "sha256:content",
    createdAt: timestamp,
    documentId,
    envelopeHash: "envelope",
    id: versionId,
    kind: "content",
    mediaType: "text/plain",
    organizationId,
    originalRenditionId: renditionId,
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
    createdAt: timestamp,
    documentId,
    documentVersionId: versionId,
    id: renditionId,
    kind: "original",
    organizationId,
  };
  const repository = {
    get: async () => brain,
    getDocument: async () => document,
    getDocumentRendition: async () => rendition,
    getDocumentVersion: async () => version,
    getSource: async () => source,
  } as unknown as BrainRepository;
  return { job, placement, repository, target };
}

function indexing(
  database: DynamoDatabaseService,
  value: {
    readonly repository: BrainRepository;
    readonly target: BrainSearchProviderClient["target"];
  },
) {
  const writes: string[][] = [];
  const provider: BrainSearchProviderClient = {
    capabilities: {
      components: ["dense", "entity", "exact", "lexical"],
      hybrid: true,
    },
    deleteDocument: async () => ({ deleted: true }),
    inspect: async () => ({ components: [], ready: true }),
    prepare: async () => undefined,
    providerId: "aws-native",
    purgeBrain: async () => ({ deleted: true, receipt: {} }),
    purgeOrganization: async () => ({ deleted: true, receipt: {} }),
    search: async () => [],
    target: value.target,
    upsert: async ({ chunks }) => {
      writes.push(chunks.map((chunk) => chunk.chunkId));
      return {
        components: (["dense", "entity", "exact", "lexical"] as const).map((kind) => ({
          kind,
          ready: true,
        })),
        written: chunks.length,
      };
    },
  };
  const run = () =>
    processBrainIndexMessage(
      { documentId, idempotencyKey, organizationId },
      {
        database,
        embeddings: () => ({ embed: async () => [1, 0] }),
        ...textExtraction,
        loadRendition: async () => new TextEncoder().encode("hello"),
        now: () => new Date(timestamp),
        providers: { resolve: async () => provider },
        repository: value.repository,
        workerId: "worker-1",
      },
    );
  return { run, writes };
}

describe("Brain index runtime", () => {
  test("claims, indexes, and atomically publishes one target-pinned document", async () => {
    const value = fixture();
    const storage = memoryDatabase([value.job, value.placement]);
    const { run, writes } = indexing(storage.database, value);
    const result = await run();

    expect(result).toMatchObject({ chunkCount: 1, outcome: "indexed" });
    expect(writes[0]).toHaveLength(1);
    expect(
      (await getBrainIndexJob(storage.database, { documentId, idempotencyKey, organizationId }))
        ?.data.status,
    ).toBe("succeeded");
    expect(
      (await getBrainIndexState(storage.database, organizationId, documentId))?.data,
    ).toMatchObject({
      chunkIds: writes[0],
      status: "ready",
    });
  });

  test("leaves a suspended organization's job queued and indexes it after release", async () => {
    let standingDatabase: DynamoDatabaseService | undefined;
    const installation = standingInstallation({
      organizationId,
      wrap: (database) => (standingDatabase = database),
    });
    const value = fixture();
    const storage = memoryDatabase([value.job, value.placement], standingDatabase);
    const { run, writes } = indexing(storage.database, value);
    const jobStatus = async () =>
      (await getBrainIndexJob(storage.database, { documentId, idempotencyKey, organizationId }))
        ?.data.status;

    await installation.placeHold("abuse");
    const held = [await run(), await jobStatus(), writes.length];
    await installation.releaseHold("abuse");
    const released = [(await run()).outcome, await jobStatus(), writes.length];

    expect([held, released]).toEqual([
      [{ outcome: "suspended" }, "queued", 0],
      ["indexed", "succeeded", 1],
    ]);
  });

  test("finishes a candidate job across exactly the migration cutover generation", async () => {
    const value = fixture();
    const candidateTarget = {
      ...value.target,
      location: {
        openSearchEndpoint: "https://search.example",
        openSearchIndex: "brain-org-v1",
        region: "us-east-2",
      },
      providerId: "aws-native" as const,
      targetId: "01ARZ3NDEKTSV4RRFFQ69G5FB8",
    };
    const candidateJob = Schema.decodeUnknownSync(BrainIndexJobRecord)(
      withCanonicalRecordKeys({
        ...value.job,
        data: {
          ...value.job.data,
          id: "01ARZ3NDEKTSV4RRFFQ69G5FB9",
          idempotencyKey: `${idempotencyKey}:${candidateTarget.targetId}`,
          placementGeneration: 2,
          provider: "aws-native" as const,
          targetId: candidateTarget.targetId,
        },
      }),
    );
    const completedPlacement = Schema.decodeUnknownSync(BrainSearchPlacementRecord)(
      withCanonicalRecordKeys({
        ...value.placement,
        data: {
          ...value.placement.data,
          generation: 3,
          readTarget: candidateTarget,
          version: 3,
          writeTarget: candidateTarget,
        },
      }),
    );
    const storage = memoryDatabase([candidateJob, completedPlacement]);
    const provider: BrainSearchProviderClient = {
      capabilities: { components: ["dense", "entity", "exact", "lexical"], hybrid: true },
      deleteDocument: async () => ({ deleted: true }),
      inspect: async () => ({ components: [], ready: true }),
      prepare: async () => undefined,
      providerId: "aws-native",
      purgeBrain: async () => ({ deleted: true, receipt: {} }),
      purgeOrganization: async () => ({ deleted: true, receipt: {} }),
      search: async () => [],
      target: candidateTarget,
      upsert: async ({ chunks }) => ({
        components: (["dense", "entity", "exact", "lexical"] as const).map((kind) => ({
          kind,
          ready: true,
        })),
        written: chunks.length,
      }),
    };

    expect(
      processBrainIndexMessage(
        {
          documentId,
          idempotencyKey: candidateJob.data.idempotencyKey,
          organizationId,
        },
        {
          database: storage.database,
          embeddings: () => ({ embed: async () => [1, 0] }),
          ...textExtraction,
          loadRendition: async () => new TextEncoder().encode("hello"),
          now: () => new Date(timestamp),
          providers: { resolve: async () => provider },
          repository: value.repository,
          workerId: "worker-1",
        },
      ),
    ).resolves.toMatchObject({ outcome: "indexed" });
  });
});
