import { describe, expect, test } from "bun:test";
import type {
  Brain,
  BrainDocument,
  BrainDocumentRendition,
  BrainDocumentVersion,
} from "@deployments-ai/brains";
import { Schema } from "effect";
import type { DynamoDatabaseService, TransactionOperation } from "../client-types.ts";
import { BrainSearchPlacementRecord } from "../records/brain-search.ts";
import { withCanonicalRecordKeys, type PlatformRecord } from "../records/index.ts";
import { backfillBrainSearchIndex, type BrainIndexBackfillRepository } from "./index-backfill.ts";
import { brainUlid } from "./record-mapping.ts";

const organizationId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const brainId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const sourceId = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const targetId = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
const timestamp = "2026-10-15T12:00:00.000Z";
const target = {
  components: [{ componentId: brainUlid("01ARZ3NDEKTSV4RRFFQ69G5FB1"), kind: "dense" as const }],
  embeddingProfileId: brainUlid("01ARZ3NDEKTSV4RRFFQ69G5FB2"),
  location: { openSearchIndex: "brain-org" },
  providerId: "aws-native" as const,
  schemaGeneration: 1,
  targetId: brainUlid(targetId),
};
const placement = Schema.decodeUnknownSync(BrainSearchPlacementRecord)(
  withCanonicalRecordKeys({
    data: {
      createdAt: timestamp,
      generation: 1,
      organizationId: brainUlid(organizationId),
      phase: "active" as const,
      readTarget: target,
      updatedAt: timestamp,
      version: 1,
      writeTarget: target,
    },
    itemType: "brain-search-placement" as const,
  }),
);

function document(id: string, lifecycle: BrainDocument["lifecycle"]): BrainDocument {
  return {
    brainId,
    createdAt: timestamp,
    currentContentVersionId: `${id.slice(0, 25)}V`,
    currentVersionId: `${id.slice(0, 25)}V`,
    externalItemIdentity: id,
    id,
    lifecycle,
    organizationId,
    projectionGeneration: 2,
    reviewStatus: "approved",
    sensitivity: "internal",
    sourceId,
    updatedAt: timestamp,
    version: 2,
  };
}

const documents = [
  document("01ARZ3NDEKTSV4RRFFQ69G5FC0", "active"),
  document("01ARZ3NDEKTSV4RRFFQ69G5FC1", "archived"),
];

const repository: BrainIndexBackfillRepository = {
  getDocumentRendition: async (_organizationId, documentVersionId, renditionId) =>
    ({
      bodyRef: {
        bucket: "content",
        byteSize: 3,
        contentType: "text/plain",
        key: "organizations/org/brains/brain/original",
        sha256: "sha256:content",
        versionId: "s3-version",
      },
      brainId,
      contentHash: "sha256:content",
      coordinateSystem: "utf8-byte",
      createdAt: timestamp,
      documentId: documents[0]!.id,
      documentVersionId,
      id: renditionId,
      kind: "original",
      organizationId,
    }) as BrainDocumentRendition,
  getDocumentVersion: async (_organizationId, documentId, versionId) =>
    ({
      brainId,
      contentHash: "sha256:content",
      createdAt: timestamp,
      documentId,
      envelopeHash: "envelope",
      id: versionId,
      kind: "content",
      organizationId,
      originalRenditionId: `${versionId.slice(0, 25)}R`,
      sourceId,
      sourceOrder: 1,
    }) as BrainDocumentVersion,
  listByOrganization: async () => ({ items: [{ id: brainId } as Brain] }),
  listDocuments: async (_organizationId, _brainId, options) =>
    options.cursor ? { items: [documents[1]!] } : { items: [documents[0]!], nextCursor: "page-2" },
};

function database() {
  const jobs = new Map<string, PlatformRecord>();
  const transactions: TransactionOperation[][] = [];
  const service = {
    getRecord: async (table: string, key: { readonly pk: string; readonly sk: string }) =>
      table === "execution" ? jobs.get(`${key.pk}\0${key.sk}`) : placement,
    transactWrite: async (operations: readonly TransactionOperation[]) => {
      transactions.push([...operations]);
      const created = operations.flatMap((operation) =>
        operation.kind === "put" && operation.record.itemType === "brain-index-job"
          ? [operation.record]
          : [],
      );
      if (created.some((job) => jobs.has(`${job.pk}\0${job.sk}`))) {
        throw new Error("TransactionCanceledException: ConditionalCheckFailed");
      }
      for (const job of created) jobs.set(`${job.pk}\0${job.sk}`, job);
    },
  } as unknown as DynamoDatabaseService;
  return { jobs, service, transactions };
}

describe("Brain search index backfill", () => {
  test("queues every active document stored before activation", async () => {
    const fixture = database();
    const result = await backfillBrainSearchIndex({
      database: fixture.service,
      organizationId,
      repository,
      targetId,
    });
    expect(result).toEqual({ queued: 1 });
    const [job] = [...fixture.jobs.values()];
    expect(job?.data).toMatchObject({
      documentId: documents[0]!.id,
      operation: "index",
      status: "queued",
      targetId,
    });
  });

  test("skips documents a previous run already queued", async () => {
    const fixture = database();
    const input = { database: fixture.service, organizationId, repository, targetId };
    await backfillBrainSearchIndex(input);
    expect(await backfillBrainSearchIndex(input)).toEqual({ queued: 0 });
    expect(fixture.jobs.size).toBe(1);
  });
});
