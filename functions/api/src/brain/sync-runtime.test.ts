import { describe, expect, test } from "bun:test";
import type {
  Brain,
  BrainDocument,
  BrainDocumentVersion,
  BrainGrant,
  BrainRepository,
  BrainSource,
} from "@deployments-ai/brains";
import {
  BrainSyncJobRecord,
  ProviderConnectionRecord,
  type DynamoDatabaseService,
  type PlatformRecord,
  withCanonicalRecordKeys,
} from "@deployments-ai/db";
import { standingInstallation } from "@deployments-ai/organization-admission/testing";
import { Schema } from "effect";
import { processBrainSyncMessage, type BrainSyncRuntimeDependencies } from "./sync-runtime.ts";

const ids = [
  "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  "01ARZ3NDEKTSV4RRFFQ69G5FAY",
  "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
  "01ARZ3NDEKTSV4RRFFQ69G5FB0",
  "01ARZ3NDEKTSV4RRFFQ69G5FB1",
  "01ARZ3NDEKTSV4RRFFQ69G5FB2",
  "01ARZ3NDEKTSV4RRFFQ69G5FB3",
] as const;
const [
  organizationId,
  brainId,
  sourceId,
  principalId,
  grantId,
  connectionId,
  projectId,
  environmentId,
  credentialId,
] = ids;
const now = "2026-07-31T12:00:00.000Z";

const brain: Brain = {
  createdAt: now,
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
  updatedAt: now,
  updatedByPrincipalId: principalId,
  version: 0,
};
const source: BrainSource = {
  brainId,
  configuration: { owner: "deployments-ai", repository: "platform" },
  connectionId,
  createdAt: now,
  createdByPrincipalId: principalId,
  environmentId,
  id: sourceId,
  kind: "github",
  name: "GitHub",
  organizationId,
  projectId,
  status: "active",
  updatedAt: now,
  updatedByPrincipalId: principalId,
  version: 0,
};
const grant: BrainGrant = {
  brainId,
  brainKind: "company",
  createdAt: now,
  grantedByPrincipalId: principalId,
  id: grantId,
  organizationId,
  permission: "owner",
  status: "active",
  target: { principalId, type: "principal" },
  updatedAt: now,
  version: 0,
};

function fixture(standingDatabase?: DynamoDatabaseService) {
  const job = Schema.decodeUnknownSync(BrainSyncJobRecord)(
    withCanonicalRecordKeys({
      data: {
        attempt: 0,
        authorizingGrantId: grantId,
        brainId,
        connectionCredentialGeneration: 1,
        connectionId,
        createdAt: now,
        id: "01ARZ3NDEKTSV4RRFFQ69G5FB4",
        idempotencyKey: `${sourceId}:initial`,
        nextDueAt: now,
        organizationId,
        priority: 100,
        requestedByPrincipalId: principalId,
        sourceId,
        status: "queued",
        updatedAt: now,
        version: 0,
      },
      itemType: "brain-sync-job" as const,
    }),
  );
  const connection = Schema.decodeUnknownSync(ProviderConnectionRecord)(
    withCanonicalRecordKeys({
      data: {
        authMethod: "oauth",
        authorizationScopes: ["repo", "read:org"],
        credentialRef: { credentialId, generation: 1, store: "dynamodb-kms" },
        createdAt: now,
        environmentId,
        id: connectionId,
        oauthIssuer: "https://github.com/login/oauth",
        oauthResource: "https://api.githubcopilot.com/mcp/",
        organizationId,
        projectId,
        providerKey: "github",
        scopes: ["tools:read", "tools:write"],
        status: "active",
        updatedAt: now,
        version: 0,
      },
      itemType: "provider-connection" as const,
    }),
  );
  const records = new Map<string, PlatformRecord>(
    [job, connection].map((record) => [`${record.pk}|${record.sk}`, record]),
  );
  const transactions: readonly PlatformRecord[][] = [];
  const mutableTransactions = transactions as PlatformRecord[][];
  const database: DynamoDatabaseService = {
    deleteRecord: async () => {},
    getRecord: async (table, key) =>
      records.get(`${key.pk}|${key.sk}`) ?? standingDatabase?.getRecord(table, key),
    putRecord: async () => {},
    queryRecords: () => Promise.resolve({ items: [] }),
    transactWrite: async (operations) => {
      const puts = operations.flatMap((operation) =>
        operation.kind === "put" ? [operation.record] : [],
      );
      mutableTransactions.push(puts);
      for (const record of puts) records.set(`${record.pk}|${record.sk}`, record);
    },
  };
  let currentDocument: BrainDocument | undefined;
  let currentVersion: BrainDocumentVersion | undefined;
  const repository: Partial<BrainRepository> = {
    beginUpload: async ({ next }) => next,
    captureDocumentRevision: async ({ document, version }) => {
      currentDocument = document;
      currentVersion = version;
      return { document, version };
    },
    completeUpload: async ({ next }) => next,
    findDocumentBySourceIdentity: async () => currentDocument,
    findSourceRevisionClaim: async () => undefined,
    get: async () => brain,
    getDocument: async () => currentDocument,
    getDocumentVersion: async () => currentVersion,
    getGrant: async () => grant,
    getSource: async () => source,
    issueUploadTicket: async ({ ticket }) => ticket,
    listDocumentsBySource: async () => ({ items: [] }),
  };
  return {
    database,
    job,
    records,
    repository: repository as BrainRepository,
    transactions,
  };
}

function syncDependencies(
  database: DynamoDatabaseService,
  repository: BrainRepository,
): BrainSyncRuntimeDependencies {
  const generated = Array.from(
    { length: 12 },
    (_, index) => `01ARZ3NDEKTSV4RRFFQ69G5F${String(20 + index).padStart(2, "0")}`,
  );
  const body = new TextEncoder().encode("# Brain\nNative evidence.\n");
  return {
    database,
    generateId: async () => generated.shift()!,
    loadGitHubSnapshot: async () => ({
      committedAt: now,
      cursor: "commit-sha",
      files: [
        {
          path: "docs/brain.md",
          read: async () => body,
          sha: "blob-sha",
          size: body.byteLength,
        },
      ],
    }),
    now: () => now,
    readGitHubAccessToken: async () => "secret-token",
    repository,
    upload: async ({ contentHash, contentType, objectKey }) => ({
      bucket: "content",
      byteSize: body.byteLength,
      contentType,
      key: objectKey,
      sha256: contentHash,
      versionId: "s3-version",
    }),
    workerId: "worker",
  };
}

describe("Brain GitHub sync runtime", () => {
  test("imports a pinned repository snapshot and schedules the next freshness check", async () => {
    const fixtureValue = fixture();
    const result = await processBrainSyncMessage(
      { brainId, idempotencyKey: fixtureValue.job.data.idempotencyKey, organizationId },
      syncDependencies(fixtureValue.database, fixtureValue.repository),
    );

    expect(result).toEqual({ imported: 1, outcome: "synchronized" });
    const writtenTypes = fixtureValue.transactions.flat().map((record) => record.itemType);
    expect(writtenTypes).toContain("brain-sync-job");
    expect(writtenTypes).toContain("brain-source");
    expect(writtenTypes).toContain("semantic-event");
    expect(
      fixtureValue.transactions
        .flat()
        .filter((record) => record.itemType === "brain-sync-job")
        .some(
          (record) => record.data.status === "queued" && record.data.syncCursor === "commit-sha",
        ),
    ).toBe(true);
  });

  test("leaves a suspended organization's job queued and imports it after release", async () => {
    let standingDatabase: DynamoDatabaseService | undefined;
    const installation = standingInstallation({
      organizationId,
      wrap: (database) => (standingDatabase = database),
    });
    const fixtureValue = fixture(standingDatabase);
    const dependencies = syncDependencies(fixtureValue.database, fixtureValue.repository);
    const message = {
      brainId,
      idempotencyKey: fixtureValue.job.data.idempotencyKey,
      organizationId,
    };

    await installation.placeHold("payment");
    const held = await processBrainSyncMessage(message, dependencies);
    const writesWhileHeld = fixtureValue.transactions.length;
    await installation.releaseHold("payment");
    const released = await processBrainSyncMessage(message, dependencies);

    expect([held, writesWhileHeld, released]).toEqual([
      { outcome: "suspended" },
      0,
      { imported: 1, outcome: "synchronized" },
    ]);
  });
});
