import { describe, expect, test } from "bun:test";
import { GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { Brain, BrainRepository } from "@deployments-ai/brains";
import {
  brainDocumentPlatformRecord,
  brainDocumentVersionPlatformRecord,
  brainPlatformRecord,
  makeBrainDynamoRepository,
  makeDynamoDatabase,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type TransactionOperation,
} from "@deployments-ai/db";
import { fakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import { detectBrainDocumentDuplicates } from "./duplicate-maintenance.ts";

const ids = "0123456789".split("").map((suffix) => `01ARZ3NDEKTSV4RRFFQ69G5FA${suffix}`);
const [organizationId, brainId, principalId, sourceId, firstDocumentId, secondDocumentId] = ids;

const brain: Brain = {
  createdAt: "2026-07-31T00:00:00.000Z",
  createdByPrincipalId: principalId!,
  id: brainId!,
  kind: "company",
  maintenancePolicy: {},
  name: "Company knowledge",
  organizationId: organizationId!,
  ownershipGeneration: 0,
  retrievalPolicy: {},
  schemaVersion: 1,
  sensitivity: "internal",
  slug: "company-knowledge",
  status: "active",
  updatedAt: "2026-07-31T00:00:00.000Z",
  updatedByPrincipalId: principalId!,
  version: 0,
};

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function ulid(prefix: string, ordinal: number) {
  let suffix = "";
  for (let remaining = ordinal; suffix.length < 26 - prefix.length; remaining >>= 5) {
    suffix = CROCKFORD[remaining % 32] + suffix;
  }
  return prefix + suffix;
}

function largeBrainRepository(documentCount: number, hashes: ReadonlyMap<number, string>) {
  const documents = Array.from({ length: documentCount }, (_, ordinal) => ({
    brainId: brain.id,
    createdAt: brain.createdAt,
    currentContentVersionId: ulid("01BX5ZZKBKACTAV9WEVGE", ordinal),
    currentEnvelopeHash: `envelope-${ordinal}`,
    currentSourceOrder: 0,
    currentVersionId: ulid("01BX5ZZKBKACTAV9WEVGE", ordinal),
    externalItemIdentity: `document-${ordinal}`,
    id: ulid("01ARZ3NDEKTSV4RRFFQ69", ordinal),
    lifecycle: ordinal === 3_000 ? ("archived" as const) : ("active" as const),
    organizationId: brain.organizationId,
    projectionGeneration: 0,
    reviewStatus: "unreviewed" as const,
    sensitivity: "internal" as const,
    sourceId: sourceId!,
    updatedAt: brain.updatedAt,
    version: 0,
  }));
  const ordinalByDocumentId = new Map(documents.map((document, ordinal) => [document.id, ordinal]));
  return {
    getDocumentVersion: async (_organizationId: string, id: string, version: string) => {
      const ordinal = ordinalByDocumentId.get(id)!;
      return {
        brainId: brain.id,
        byteSize: 10,
        contentHash: hashes.get(ordinal) ?? `sha256:unique-${ordinal}`,
        createdAt: brain.createdAt,
        documentId: id,
        envelopeHash: `envelope-${ordinal}`,
        id: version,
        kind: "content" as const,
        mediaType: "text/plain",
        organizationId: brain.organizationId,
        originalRenditionId: ids[8]!,
        sourceId: sourceId!,
        sourceOrder: 0,
      };
    },
    getReviewItem: async () => undefined,
    listDocuments: async (
      _organizationId: string,
      _brainId: string,
      options: { readonly cursor?: string; readonly limit: number },
    ) => {
      if (options.limit > 100) {
        throw new Error("Brain resource list limit must be between 1 and 100.");
      }
      const start = options.cursor ? Number(options.cursor) : 0;
      const end = start + options.limit;
      return {
        items: documents.slice(start, end),
        ...(end < documents.length ? { nextCursor: String(end) } : {}),
      };
    },
  } as unknown as BrainRepository;
}

describe("Brain duplicate maintenance", () => {
  test("creates one deterministic review for a current duplicate group", async () => {
    const captured: TransactionOperation[][] = [];
    const database = {
      getRecord: async () => undefined,
      transactWrite: async (operations: readonly TransactionOperation[]) => {
        captured.push([...operations]);
      },
    } as unknown as DynamoDatabaseService;
    const documents = [firstDocumentId!, secondDocumentId!].map((id, index) => ({
      brainId: brain.id,
      createdAt: brain.createdAt,
      currentContentVersionId: ids[6 + index]!,
      currentEnvelopeHash: `envelope-${index}`,
      currentSourceOrder: 0,
      currentVersionId: ids[6 + index]!,
      externalItemIdentity: `document-${index}`,
      id,
      lifecycle: "active" as const,
      organizationId: brain.organizationId,
      projectionGeneration: 0,
      reviewStatus: "unreviewed" as const,
      sensitivity: "internal" as const,
      sourceId: sourceId!,
      updatedAt: brain.updatedAt,
      version: 0,
    }));
    const repository = {
      getDocumentVersion: async (_organizationId: string, documentId: string) => ({
        brainId: brain.id,
        byteSize: 10,
        contentHash: "sha256:duplicate",
        createdAt: brain.createdAt,
        documentId,
        envelopeHash: "envelope",
        id: documents.find((item) => item.id === documentId)!.currentContentVersionId!,
        kind: "content" as const,
        mediaType: "text/plain",
        organizationId: brain.organizationId,
        originalRenditionId: ids[8]!,
        sourceId: sourceId!,
        sourceOrder: 0,
      }),
      getReviewItem: async () => undefined,
      listDocuments: async () => ({ items: documents }),
    } as unknown as BrainRepository;

    const result = await detectBrainDocumentDuplicates({
      brain,
      database,
      generateId: async () => ids[9]!,
      now: "2026-07-31T01:00:00.000Z",
      repository,
    });

    expect(result).toEqual({ groups: 1, reviewsCreated: 1 });
    const review = captured[0]!.find(
      (operation) => operation.kind === "put" && operation.record.itemType === "brain-review-item",
    );
    expect(review?.kind === "put" && review.record.data).toMatchObject({
      brainId,
      kind: "duplicate-document",
      proposal: { documentIds: [firstDocumentId, secondDocumentId] },
      status: "open",
    });
  });

  test("finds duplicate groups across every page of a Brain with more than 5,000 documents", async () => {
    const captured: TransactionOperation[][] = [];
    const database = {
      getRecord: async () => undefined,
      transactWrite: async (operations: readonly TransactionOperation[]) => {
        captured.push([...operations]);
      },
    } as unknown as DynamoDatabaseService;
    const repository = largeBrainRepository(
      5_200,
      new Map([
        [0, "sha256:alpha"],
        [10, "sha256:beta"],
        [2_500, "sha256:beta"],
        [3_000, "sha256:alpha"],
        [5_150, "sha256:alpha"],
        [5_199, "sha256:beta"],
      ]),
    );

    const result = await detectBrainDocumentDuplicates({
      brain,
      database,
      generateId: async () => ids[9]!,
      now: "2026-07-31T01:00:00.000Z",
      repository,
    });

    expect(result).toEqual({ groups: 2, reviewsCreated: 2 });
    const proposals = captured.flatMap((operations) =>
      operations.flatMap((operation) =>
        operation.kind === "put" && operation.record.itemType === "brain-review-item"
          ? [operation.record.data.proposal]
          : [],
      ),
    );
    expect(proposals).toEqual([
      {
        contentHash: "sha256:alpha",
        documentIds: ["01ARZ3NDEKTSV4RRFFQ6900000", "01ARZ3NDEKTSV4RRFFQ690050Y"],
        versionIds: ["01BX5ZZKBKACTAV9WEVGE00000", "01BX5ZZKBKACTAV9WEVGE0050Y"],
      },
      {
        contentHash: "sha256:beta",
        documentIds: [
          "01ARZ3NDEKTSV4RRFFQ690000A",
          "01ARZ3NDEKTSV4RRFFQ69002E4",
          "01ARZ3NDEKTSV4RRFFQ690052F",
        ],
        versionIds: [
          "01BX5ZZKBKACTAV9WEVGE0000A",
          "01BX5ZZKBKACTAV9WEVGE002E4",
          "01BX5ZZKBKACTAV9WEVGE0052F",
        ],
      },
    ]);
  });
});

function storedBrain() {
  const dynamo = fakeDynamoDocumentClient();
  let versionReads = 0;
  const client = {
    send: (command: unknown) => {
      if (
        command instanceof GetCommand &&
        String(command.input.Key?.sk).startsWith("BRAIN-DOCUMENT-VERSION#")
      ) {
        versionReads += 1;
      }
      return dynamo.client.send(command as GetCommand);
    },
  } as unknown as DynamoDBDocumentClient;
  const database = makeDynamoDatabase(client);
  dynamo.put(
    "control",
    withCanonicalRecordKeys({
      data: {
        createdAt: brain.createdAt,
        id: brain.organizationId,
        name: "Deployments.ai",
        slug: "deployments-ai",
        status: "active",
        updatedAt: brain.updatedAt,
        version: 1,
      },
      itemType: "organization" as const,
    }),
  );
  dynamo.put("control", brainPlatformRecord(brain));
  const document = (ordinal: number, lifecycle: "active" | "archived" = "active") => ({
    brainId: brain.id,
    createdAt: brain.createdAt,
    currentContentVersionId: ulid("01BX5ZZKBKACTAV9WEVGE", ordinal),
    currentEnvelopeHash: `envelope-${ordinal}`,
    currentSourceOrder: 0,
    currentVersionId: ulid("01BX5ZZKBKACTAV9WEVGE", ordinal),
    externalItemIdentity: `document-${ordinal}`,
    id: ulid("01ARZ3NDEKTSV4RRFFQ69", ordinal),
    lifecycle,
    organizationId: brain.organizationId,
    projectionGeneration: 0,
    reviewStatus: "unreviewed" as const,
    sensitivity: "internal" as const,
    sourceId: sourceId!,
    updatedAt: brain.updatedAt,
    version: 0,
  });
  let eventOrdinal = 0;
  return {
    archive(ordinal: number) {
      dynamo.put("control", brainDocumentPlatformRecord(document(ordinal, "archived")));
    },
    capture(ordinal: number, contentHash: string) {
      const current = document(ordinal);
      dynamo.put("control", brainDocumentPlatformRecord(current));
      dynamo.put(
        "control",
        brainDocumentVersionPlatformRecord({
          bodyRef: {
            bucket: "brain-content",
            byteSize: 10,
            contentType: "text/plain",
            key: `documents/${ordinal}`,
            sha256: contentHash,
            versionId: "s3-version",
          },
          brainId: brain.id,
          byteSize: 10,
          contentHash,
          createdAt: brain.createdAt,
          documentId: current.id,
          envelopeHash: current.currentEnvelopeHash,
          id: current.currentContentVersionId,
          kind: "content",
          mediaType: "text/plain",
          organizationId: brain.organizationId,
          originalRenditionId: ids[8]!,
          sourceId: sourceId!,
          sourceOrder: 0,
        }),
      );
    },
    async run(now: string) {
      versionReads = 0;
      const result = await detectBrainDocumentDuplicates({
        brain,
        database,
        generateId: async () => ulid("01CX5ZZKBKACTAV9WEVGE", (eventOrdinal += 1)),
        now,
        repository: makeBrainDynamoRepository(database),
      });
      return { ...result, versionReads };
    },
  };
}

describe("Brain duplicate maintenance across runs", () => {
  test("scans a Brain on its first run and again only after its current documents change", async () => {
    const store = storedBrain();
    store.capture(0, "sha256:alpha");
    store.capture(1, "sha256:alpha");
    store.capture(2, "sha256:beta");

    expect(await store.run("2026-10-22T10:00:00.000Z")).toEqual({
      groups: 1,
      reviewsCreated: 1,
      versionReads: 3,
    });
    expect(await store.run("2026-10-22T10:05:00.000Z")).toEqual({
      groups: 1,
      reviewsCreated: 0,
      versionReads: 0,
    });

    store.capture(3, "sha256:beta");
    expect(await store.run("2026-10-22T10:10:00.000Z")).toEqual({
      groups: 2,
      reviewsCreated: 1,
      versionReads: 4,
    });
    expect(await store.run("2026-10-22T10:15:00.000Z")).toEqual({
      groups: 2,
      reviewsCreated: 0,
      versionReads: 0,
    });

    store.archive(3);
    expect(await store.run("2026-10-22T10:20:00.000Z")).toEqual({
      groups: 1,
      reviewsCreated: 0,
      versionReads: 3,
    });
  });
});
