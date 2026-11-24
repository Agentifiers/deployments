import { describe, expect, test } from "bun:test";
import type {
  Brain,
  BrainDocument,
  BrainDocumentRendition,
  BrainDocumentVersion,
  BrainGrant,
  BrainSource,
  BrainSourceRevisionClaim,
  BrainUploadTicket,
} from "@deployments-ai/brains";
import type { DynamoDatabaseService, TransactionOperation } from "../client-types.ts";
import { brainMutationCallerConditions } from "./knowledge-mutation-conditions.ts";
import { makeBrainKnowledgeRepository } from "./knowledge-repository.ts";
import { brainPlatformRecord } from "./record-mapping.ts";

const organizationId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const brainId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const principalId = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const grantId = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const sourceId = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
const documentId = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
const versionId = "01ARZ3NDEKTSV4RRFFQ69G5FB1";
const revisionClaimId = "01ARZ3NDEKTSV4RRFFQ69G5FB2";
const eventId = "01ARZ3NDEKTSV4RRFFQ69G5FB3";
const renditionId = "01ARZ3NDEKTSV4RRFFQ69G5FB4";
const ticketId = "01ARZ3NDEKTSV4RRFFQ69G5FB5";
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

const ownerGrant: BrainGrant = {
  brainId,
  brainKind: "company",
  createdAt: timestamp,
  grantedByPrincipalId: principalId,
  id: grantId,
  organizationId,
  permission: "owner",
  status: "active",
  target: { principalId, type: "principal" },
  updatedAt: timestamp,
  version: 0,
};

const source: BrainSource = {
  brainId,
  createdAt: timestamp,
  createdByPrincipalId: principalId,
  id: sourceId,
  kind: "upload",
  name: "Uploads",
  organizationId,
  status: "active",
  updatedAt: timestamp,
  updatedByPrincipalId: principalId,
  version: 0,
};

function fakeDatabase() {
  const transactions: TransactionOperation[][] = [];
  const brainRecord = brainPlatformRecord(brain);
  const database: DynamoDatabaseService = {
    deleteRecord: async () => {},
    getRecord: async (_table, recordKey) =>
      recordKey.pk === brainRecord.pk && recordKey.sk === brainRecord.sk ? brainRecord : undefined,
    putRecord: async () => {},
    queryRecords: async () => ({ items: [] }),
    transactWrite: async (operations) => {
      transactions.push([...operations]);
      return;
    },
  };
  return { database, transactions };
}

describe("Brain knowledge repository", () => {
  test("creates a source behind live owner, principal, membership, and Brain fences", async () => {
    const fake = fakeDatabase();
    await makeBrainKnowledgeRepository(fake.database).createSource({
      actor: { kind: "human", principalId },
      authorizingGrant: ownerGrant,
      eventId,
      source,
    });

    const operations = fake.transactions[0]!;
    expect(
      operations
        .filter((operation) => operation.kind === "condition-check")
        .map((operation) => operation.expressionAttributeValues?.[":itemType"]),
    ).toEqual(["organization", "principal", "organization-member", "brain", "brain-grant"]);
    expect(
      operations
        .filter((operation) => operation.kind === "put")
        .map((operation) => operation.record.itemType),
    ).toEqual(["brain-source", "semantic-event"]);
  });

  test("announces an upload source without a sync job identity", async () => {
    const fake = fakeDatabase();
    await makeBrainKnowledgeRepository(fake.database).createSource({
      actor: { kind: "human", principalId },
      authorizingGrant: ownerGrant,
      eventId,
      source,
    });

    // The sync dispatcher's EventBridge rule matches only events carrying the sync job identity.
    const event = fake.transactions[0]!.flatMap((operation) =>
      operation.kind === "put" && operation.record.itemType === "semantic-event"
        ? [operation.record.data]
        : [],
    )[0];
    expect(event).toMatchObject({
      eventType: "brain-source.created",
      payload: { brainId, kind: "upload", sourceId },
    });
    expect(event?.payload).not.toHaveProperty("syncJobId");
    expect(event?.payload).not.toHaveProperty("syncJobIdempotencyKey");
  });

  test("atomically creates item identity, document, immutable version, revision claim, and event", async () => {
    const fake = fakeDatabase();
    const document: BrainDocument = {
      brainId,
      createdAt: timestamp,
      currentEnvelopeHash: "envelope-1",
      currentSourceOrder: 1,
      currentVersionId: versionId,
      externalItemIdentity: "decision-42",
      id: documentId,
      lifecycle: "archived",
      organizationId,
      projectionGeneration: 0,
      reviewStatus: "unreviewed",
      sensitivity: "internal",
      sourceId,
      updatedAt: timestamp,
      version: 0,
    };
    const version: BrainDocumentVersion = {
      brainId,
      createdAt: timestamp,
      documentId,
      envelopeHash: "envelope-1",
      id: versionId,
      kind: "archive",
      organizationId,
      sourceId,
      sourceOrder: 1,
      sourceRevision: "revision-1",
    };
    const revisionClaim: BrainSourceRevisionClaim = {
      brainId,
      createdAt: timestamp,
      documentId,
      externalItemIdentity: "decision-42",
      fingerprint: "envelope-1",
      id: revisionClaimId,
      organizationId,
      revisionKey: "revision-1",
      sourceId,
      versionId,
    };

    await makeBrainKnowledgeRepository(fake.database).captureDocumentRevision({
      actor: { kind: "human", principalId },
      authorizingGrant: ownerGrant,
      document,
      eventId,
      revisionClaim,
      source,
      version,
    });

    expect(
      fake.transactions[0]!.find(
        (operation) =>
          operation.kind === "condition-check" &&
          operation.expressionAttributeValues?.[":itemType"] === "brain-grant",
      ),
    ).toMatchObject({
      expressionAttributeValues: {
        ":permission": "owner",
        ":targetField": principalId,
        ":targetType": "principal",
      },
    });

    expect(
      fake.transactions[0]!.filter((operation) => operation.kind === "put").map(
        (operation) => operation.record.itemType,
      ),
    ).toEqual([
      "brain-document",
      "unique-claim",
      "brain-source-item-claim",
      "unique-claim",
      "brain-document-version",
      "brain-source-revision-claim",
      "unique-claim",
      "semantic-event",
    ]);
  });

  test("rejects a read-only grant before issuing a Brain content transaction", async () => {
    const fake = fakeDatabase();
    const repository = makeBrainKnowledgeRepository(fake.database);

    expect(
      repository.captureDocumentRevision({
        actor: { kind: "human", principalId },
        authorizingGrant: { ...ownerGrant, permission: "reader" },
        document: {
          brainId,
          createdAt: timestamp,
          currentEnvelopeHash: "envelope-read-only",
          currentSourceOrder: 1,
          currentVersionId: versionId,
          externalItemIdentity: "read-only-item",
          id: documentId,
          lifecycle: "archived",
          organizationId,
          projectionGeneration: 0,
          reviewStatus: "unreviewed",
          sensitivity: "internal",
          sourceId,
          updatedAt: timestamp,
          version: 0,
        },
        eventId,
        revisionClaim: {
          brainId,
          createdAt: timestamp,
          documentId,
          externalItemIdentity: "read-only-item",
          fingerprint: "envelope-read-only",
          id: revisionClaimId,
          organizationId,
          revisionKey: "revision-read-only",
          sourceId,
          versionId,
        },
        source,
        version: {
          brainId,
          createdAt: timestamp,
          documentId,
          envelopeHash: "envelope-read-only",
          id: versionId,
          kind: "archive",
          organizationId,
          sourceId,
          sourceOrder: 1,
          sourceRevision: "revision-read-only",
        },
      }),
    ).rejects.toThrow("write grant");
    expect(fake.transactions).toHaveLength(0);
  });

  test("conditions service mutations on live Brain scopes at both credential layers", () => {
    const conditions = brainMutationCallerConditions(
      {
        apiCredentialId: "01ARZ3NDEKTSV4RRFFQ69G5FB6",
        environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FB7",
        kind: "service",
        projectId: "01ARZ3NDEKTSV4RRFFQ69G5FB8",
        serviceAccountId: "01ARZ3NDEKTSV4RRFFQ69G5FB9",
      },
      {
        ...ownerGrant,
        id: "01ARZ3NDEKTSV4RRFFQ69G5FBA",
        permission: "read-write",
        target: {
          environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FB7",
          projectId: "01ARZ3NDEKTSV4RRFFQ69G5FB8",
          serviceAccountId: "01ARZ3NDEKTSV4RRFFQ69G5FB9",
          type: "service-account",
        },
      },
      organizationId,
      timestamp,
    );

    expect(conditions).toHaveLength(2);
    for (const condition of conditions) {
      expect(condition.conditionExpression).toContain("contains(#data.#scopes, :writeScope)");
      expect(condition.expressionAttributeValues).toMatchObject({
        ":brainWildcard": "brains:*",
        ":platformAdmin": "platform:admin",
        ":platformWildcard": "platform:*",
        ":writeScope": "brains:write",
      });
    }
  });

  test("commits the immutable original rendition with a consumed content ticket", async () => {
    const fake = fakeDatabase();
    const bodyRef = {
      bucket: "content",
      byteSize: 3,
      contentType: "text/plain",
      key: `organizations/${organizationId}/brains/${brainId}/document-versions/${versionId}/original`,
      sha256: "sha256:content",
      versionId: "s3-version-1",
    };
    const document: BrainDocument = {
      brainId,
      createdAt: timestamp,
      currentContentVersionId: versionId,
      currentEnvelopeHash: "envelope-content",
      currentSourceOrder: 1,
      currentVersionId: versionId,
      externalItemIdentity: "decision-content",
      id: documentId,
      lifecycle: "active",
      organizationId,
      projectionGeneration: 0,
      reviewStatus: "unreviewed",
      sensitivity: "internal",
      sourceId,
      updatedAt: timestamp,
      version: 0,
    };
    const version: BrainDocumentVersion = {
      bodyRef,
      brainId,
      byteSize: 3,
      contentHash: bodyRef.sha256,
      createdAt: timestamp,
      documentId,
      envelopeHash: "envelope-content",
      id: versionId,
      kind: "content",
      mediaType: "text/plain",
      organizationId,
      originalRenditionId: renditionId,
      sourceId,
      sourceOrder: 1,
    };
    const rendition: BrainDocumentRendition = {
      bodyRef,
      brainId,
      contentHash: bodyRef.sha256,
      coordinateSystem: "utf8-byte",
      createdAt: timestamp,
      documentId,
      documentVersionId: versionId,
      id: renditionId,
      kind: "original",
      organizationId,
    };
    const completed: BrainUploadTicket = {
      bodyRef,
      brainId,
      completedAt: timestamp,
      createdAt: timestamp,
      createdByPrincipalId: principalId,
      expectedByteSize: 3,
      expectedContentHash: bodyRef.sha256,
      expiresAt: "2026-07-30T12:05:00.000Z",
      id: ticketId,
      mediaType: "text/plain",
      objectKey: bodyRef.key,
      organizationId,
      sourceId,
      status: "completed",
      updatedAt: timestamp,
      version: 2,
    };
    const consumed: BrainUploadTicket = {
      ...completed,
      consumedAt: timestamp,
      documentId,
      documentVersionId: versionId,
      revisionClaimId,
      status: "consumed",
      version: 3,
    };

    await makeBrainKnowledgeRepository(fake.database).captureDocumentRevision({
      actor: { kind: "human", principalId },
      authorizingGrant: ownerGrant,
      document,
      eventId,
      rendition,
      revisionClaim: {
        brainId,
        createdAt: timestamp,
        documentId,
        externalItemIdentity: document.externalItemIdentity,
        fingerprint: version.envelopeHash,
        id: revisionClaimId,
        organizationId,
        revisionKey: "revision-content",
        sourceId,
        versionId,
      },
      source,
      uploadTicket: { next: consumed, previous: completed },
      version,
    });

    expect(
      fake.transactions[0]!.filter((operation) => operation.kind === "put").map(
        (operation) => operation.record.itemType,
      ),
    ).toContain("brain-document-rendition");
  });
});
