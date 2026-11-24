import { describe, expect, test } from "bun:test";
import type {
  Brain,
  BrainDocument,
  BrainDocumentRendition,
  BrainDocumentVersion,
  BrainEntity,
  BrainSource,
} from "@deployments-ai/brains";
import { MAX_BRAIN_GRAPH_PROJECTION_CANDIDATES } from "@deployments-ai/brains";
import type { DynamoDatabaseService, TransactionOperation } from "../client-types.ts";
import type { PlatformRecord } from "../records/index.ts";
import { prepareDynamoTransactionOperations } from "../dynamo-database.ts";
import { makeUniqueClaimRecord, uniqueClaimRequirements } from "../unique-claims.ts";
import { makeBrainGraphRepository } from "./graph-repository.ts";
import { brainEntityPlatformRecord } from "./record-mapping.ts";

const ids = [
  "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  "01ARZ3NDEKTSV4RRFFQ69G5FAY",
  "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
  "01ARZ3NDEKTSV4RRFFQ69G5FB0",
  "01ARZ3NDEKTSV4RRFFQ69G5FB1",
] as const;
const [organizationId, brainId, sourceId, documentId, versionId, renditionId, principalId] = ids;
const timestamp = "2026-07-30T12:00:00.000Z";

const brain: Brain = {
  createdAt: timestamp,
  createdByPrincipalId: principalId,
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
  updatedByPrincipalId: principalId,
  version: 0,
};
const source: BrainSource = {
  brainId,
  createdAt: timestamp,
  createdByPrincipalId: principalId,
  id: sourceId,
  kind: "upload",
  name: "Upload",
  organizationId,
  status: "active",
  updatedAt: timestamp,
  updatedByPrincipalId: principalId,
  version: 0,
};
const document: BrainDocument = {
  brainId,
  createdAt: timestamp,
  currentContentVersionId: versionId,
  currentEnvelopeHash: "sha256:envelope",
  currentSourceOrder: 1,
  currentVersionId: versionId,
  externalItemIdentity: "decision",
  id: documentId,
  lifecycle: "active",
  organizationId,
  projectionGeneration: 1,
  reviewStatus: "approved",
  sensitivity: "internal",
  sourceId,
  updatedAt: timestamp,
  version: 0,
};
const version: BrainDocumentVersion = {
  brainId,
  contentHash: "sha256:content",
  createdAt: timestamp,
  documentId,
  envelopeHash: "sha256:envelope",
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
    byteSize: 7,
    contentType: "text/plain",
    key: `organizations/${organizationId}/brains/${brainId}/body`,
    sha256: "sha256:content",
    versionId: "v1",
  },
  brainId,
  contentHash: "sha256:content",
  coordinateSystem: "unicode-scalar",
  createdAt: timestamp,
  documentId,
  documentVersionId: versionId,
  id: renditionId,
  kind: "original",
  organizationId,
};

function fakeDatabase(records: readonly PlatformRecord[] = []) {
  const values = new Map(records.map((record) => [`${record.pk}|${record.sk}`, record]));
  const transactions: TransactionOperation[][] = [];
  const database: DynamoDatabaseService = {
    deleteRecord: async () => {},
    getRecord: async (_table, key) =>
      values.has(`${key.pk}|${key.sk}`) ? values.get(`${key.pk}|${key.sk}`)! : undefined,
    putRecord: async () => {},
    queryRecords: async () => ({ items: [] }),
    transactWrite: async (operations) => {
      transactions.push([...operations]);
      return;
    },
  };
  return { database, transactions };
}

function entity(id: string, aliases: readonly string[]): BrainEntity {
  return {
    brainId,
    canonicalName: aliases[0]!,
    createdAt: timestamp,
    externalIdentifiers: {},
    id,
    kind: "concept",
    normalizedAliases: aliases,
    organizationId,
    reviewStatus: "unreviewed",
    status: "active",
    updatedAt: timestamp,
    version: 0,
  };
}

function recordsForEntity(value: BrainEntity): PlatformRecord[] {
  const record = brainEntityPlatformRecord(value);
  return [
    record,
    ...uniqueClaimRequirements(record).map(
      (requirement) => makeUniqueClaimRecord(requirement, timestamp) as PlatformRecord,
    ),
  ];
}

describe("Brain graph repository", () => {
  test("atomically persists deterministic entities, provenance edges, and a semantic event", async () => {
    const fake = fakeDatabase();
    const result = await makeBrainGraphRepository(fake.database, () => timestamp).publishProjection(
      {
        attemptId: versionId,
        candidates: [{ canonicalName: "Acme", kind: "company", normalizedAliases: ["acme"] }],
        snapshot: { brain, document, rendition, source, version },
      },
    );

    expect(result.entityIds).toHaveLength(1);
    expect(result.edgeIds).toHaveLength(1);
    const operations = fake.transactions[0]!;
    expect(
      operations
        .filter((operation) => operation.kind === "put")
        .map((operation) => operation.record.itemType),
    ).toEqual(["brain-entity", "unique-claim", "brain-edge", "semantic-event"]);
    const edge = operations.find(
      (operation) => operation.kind === "put" && operation.record.itemType === "brain-edge",
    );
    expect(edge?.kind === "put" ? edge.record.data : undefined).toMatchObject({
      documentVersionId: versionId,
      extractionMethod: "deterministic",
      relation: "mentions",
      renditionId,
    });
    const event = operations.find(
      (operation) => operation.kind === "put" && operation.record.itemType === "semantic-event",
    );
    expect(event?.kind === "put" ? event.record.data : undefined).toMatchObject({
      aggregateId: versionId,
      aggregateType: "brain-document-version",
      aggregateVersion: 2,
      eventType: "brain-document.graph-projected",
    });
  });

  test("creates an ambiguity review instead of merging aliases across canonical entities", async () => {
    const first = entity("01ARZ3NDEKTSV4RRFFQ69G5FB2", ["acme"]);
    const second = entity("01ARZ3NDEKTSV4RRFFQ69G5FB3", ["acme labs"]);
    const fake = fakeDatabase([...recordsForEntity(first), ...recordsForEntity(second)]);
    const result = await makeBrainGraphRepository(fake.database, () => timestamp).publishProjection(
      {
        attemptId: versionId,
        candidates: [
          {
            canonicalName: "Acme Labs",
            kind: "company",
            normalizedAliases: ["acme", "acme labs"],
          },
        ],
        snapshot: { brain, document, rendition, source, version },
      },
    );

    expect(result.entityIds).toEqual([]);
    expect(result.edgeIds).toEqual([]);
    expect(result.reviewItemIds).toHaveLength(1);
    const review = fake.transactions[0]!.find(
      (operation) => operation.kind === "put" && operation.record.itemType === "brain-review-item",
    );
    expect(review?.kind === "put" ? review.record.data : undefined).toMatchObject({
      kind: "entity-merge",
      status: "open",
    });
  });

  test("keeps the maximum projection within the fully expanded transaction limit", async () => {
    const fake = fakeDatabase();
    const candidates = Array.from(
      { length: MAX_BRAIN_GRAPH_PROJECTION_CANDIDATES },
      (_, index) => ({
        canonicalName: `Concept ${index}`,
        kind: "concept" as const,
        normalizedAliases: [`concept-${index}`],
      }),
    );

    await makeBrainGraphRepository(fake.database, () => timestamp).publishProjection({
      attemptId: versionId,
      candidates,
      snapshot: { brain, document, rendition, source, version },
    });

    const expanded = await prepareDynamoTransactionOperations(fake.transactions[0] ?? []);
    expect(expanded).toHaveLength(99);
  });

  test("rejects alias sets that cannot fit atomically", async () => {
    const fake = fakeDatabase();
    expect(
      makeBrainGraphRepository(fake.database, () => timestamp).publishProjection({
        attemptId: versionId,
        candidates: [
          {
            canonicalName: "Oversized",
            kind: "concept",
            normalizedAliases: Array.from(
              { length: MAX_BRAIN_GRAPH_PROJECTION_CANDIDATES + 1 },
              (_, index) => `alias-${index}`,
            ),
          },
        ],
        snapshot: { brain, document, rendition, source, version },
      }),
    ).rejects.toThrow("too many aliases");
    expect(fake.transactions).toEqual([]);
  });
});
