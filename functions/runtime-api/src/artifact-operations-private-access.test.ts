import {
  Ulid,
  brainDocumentPlatformRecord,
  brainDocumentRenditionPlatformRecord,
  brainDocumentVersionPlatformRecord,
  brainGrantPlatformRecord,
  brainPlatformRecord,
  brainSourcePlatformRecord,
  key,
  makeUniqueClaimRecord,
  uniqueClaimRequirements,
  type DynamoDatabaseService,
  type PlatformRecord,
} from "@deployments-ai/db";
import {
  brainNormalizedRendition,
  brainNormalizedTextKey,
  type Brain,
  type BrainDocument,
  type BrainDocumentRendition,
  type BrainDocumentVersion,
  type BrainGrant,
  type BrainSource,
} from "@deployments-ai/brains";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  completeArtifactUpload,
  createArtifactAccessUrl,
  getArtifact,
  listArtifacts,
  updateArtifactRetention,
} from "./artifact-operations.ts";
import {
  ORGANIZATION_ID,
  THREAD_TWO_ID,
  RUN_ONE_ID,
  RUN_TWO_ID,
  ARTIFACT_ONE_ID,
  ARTIFACT_TWO_ID,
  ARTIFACT_THREE_ID,
  ARTIFACT_PENDING_ID,
  NOW,
  scope,
  principal,
  otherPrincipal,
  generatedUlid,
  makeDatabase,
  artifact,
  dependencies,
} from "./artifact-operations.fixture.ts";

describe("artifact operations", () => {
  test("keeps private customer artifacts visible only to their owner", async () => {
    const store = makeDatabase();
    store.put("execution", artifact(ARTIFACT_ONE_ID));
    store.put(
      "execution",
      artifact(ARTIFACT_TWO_ID, {
        ownerServiceAccountId: null,
      }),
    );
    store.put(
      "execution",
      artifact(ARTIFACT_THREE_ID, {
        visibility: "organization",
      }),
    );
    const api = dependencies(store.database);

    const ownerPage = await listArtifacts(api, principal, {});
    const otherPage = await listArtifacts(api, otherPrincipal, {});

    expect(ownerPage.artifacts.map((value) => String(value.artifactId)).toSorted()).toEqual(
      [ARTIFACT_ONE_ID, ARTIFACT_THREE_ID].toSorted(),
    );
    expect(otherPage.artifacts.map((value) => String(value.artifactId))).toEqual([
      ARTIFACT_THREE_ID,
    ]);
    expect(
      getArtifact(api, otherPrincipal, Schema.decodeUnknownSync(Ulid)(ARTIFACT_THREE_ID)),
    ).resolves.toMatchObject({ artifactId: ARTIFACT_THREE_ID });
    expect(
      getArtifact(api, otherPrincipal, Schema.decodeUnknownSync(Ulid)(ARTIFACT_ONE_ID)),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });
    expect(
      completeArtifactUpload(api, otherPrincipal, Schema.decodeUnknownSync(Ulid)(ARTIFACT_ONE_ID)),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });
    expect(
      createArtifactAccessUrl(
        api,
        otherPrincipal,
        Schema.decodeUnknownSync(Ulid)(ARTIFACT_ONE_ID),
        {},
      ),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });
    expect(
      updateArtifactRetention(
        api,
        otherPrincipal,
        Schema.decodeUnknownSync(Ulid)(ARTIFACT_ONE_ID),
        {
          expectedVersion: 0,
          retentionExpiresAt: "2026-08-25T12:00:00.000Z",
        },
      ),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });
    expect(
      getArtifact(api, otherPrincipal, Schema.decodeUnknownSync(Ulid)(ARTIFACT_TWO_ID)),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });
  });

  test("preserves tenant access to legacy private runtime artifacts", async () => {
    const store = makeDatabase();
    store.put(
      "execution",
      artifact(ARTIFACT_ONE_ID, {
        agentDeploymentId: RUN_ONE_ID,
        ownerServiceAccountId: null,
      }),
    );

    expect(
      getArtifact(
        dependencies(store.database),
        otherPrincipal,
        Schema.decodeUnknownSync(Ulid)(ARTIFACT_ONE_ID),
      ),
    ).resolves.toMatchObject({ artifactId: ARTIFACT_ONE_ID });
  });

  test("revalidates Brain grants and a cited PDF's text rendition before private artifact access", async () => {
    const store = makeDatabase();
    const brainId = Schema.decodeUnknownSync(Ulid)(THREAD_TWO_ID);
    const sourceId = Schema.decodeUnknownSync(Ulid)(RUN_ONE_ID);
    const documentId = Schema.decodeUnknownSync(Ulid)(RUN_TWO_ID);
    const versionId = Schema.decodeUnknownSync(Ulid)(ARTIFACT_TWO_ID);
    const renditionId = Schema.decodeUnknownSync(Ulid)(ARTIFACT_THREE_ID);
    const grantId = Schema.decodeUnknownSync(Ulid)(ARTIFACT_PENDING_ID);
    const brain: Brain = {
      createdAt: NOW,
      createdByPrincipalId: principal.serviceAccount.data.id,
      id: brainId,
      kind: "company",
      maintenancePolicy: {},
      name: "Company Brain",
      organizationId: scope.organizationId,
      ownershipGeneration: 0,
      retrievalPolicy: {},
      schemaVersion: 1,
      sensitivity: "internal",
      slug: "company-brain",
      status: "active",
      updatedAt: NOW,
      updatedByPrincipalId: principal.serviceAccount.data.id,
      version: 0,
    };
    const grant: BrainGrant = {
      brainId,
      brainKind: "company",
      createdAt: NOW,
      grantedByPrincipalId: principal.serviceAccount.data.id,
      id: grantId,
      organizationId: scope.organizationId,
      permission: "read",
      status: "active",
      target: {
        environmentId: scope.environmentId,
        projectId: scope.projectId,
        serviceAccountId: principal.serviceAccount.data.id,
        type: "service-account",
      },
      updatedAt: NOW,
      version: 0,
    };
    const source: BrainSource = {
      brainId,
      createdAt: NOW,
      createdByPrincipalId: principal.serviceAccount.data.id,
      id: sourceId,
      kind: "upload",
      name: "Evidence",
      organizationId: scope.organizationId,
      status: "active",
      updatedAt: NOW,
      updatedByPrincipalId: principal.serviceAccount.data.id,
      version: 0,
    };
    const document: BrainDocument = {
      brainId,
      createdAt: NOW,
      currentContentVersionId: versionId,
      currentEnvelopeHash: "envelope-hash",
      currentSourceOrder: 1,
      currentVersionId: versionId,
      externalItemIdentity: "evidence-1",
      id: documentId,
      lifecycle: "active",
      organizationId: scope.organizationId,
      projectionGeneration: 1,
      reviewStatus: "approved",
      sensitivity: "internal",
      sourceId,
      updatedAt: NOW,
      version: 0,
    };
    const version: BrainDocumentVersion = {
      bodyRef: {
        bucket: "artifact-bucket",
        byteSize: 12,
        contentType: "application/pdf",
        key: "brain-evidence-original",
        sha256: "evidence-hash",
        versionId: "s3-version-1",
      },
      brainId,
      byteSize: 12,
      contentHash: "evidence-hash",
      createdAt: NOW,
      documentId,
      envelopeHash: "envelope-hash",
      id: versionId,
      kind: "content",
      mediaType: "application/pdf",
      organizationId: scope.organizationId,
      originalRenditionId: renditionId,
      sourceId,
      sourceOrder: 1,
    };
    const original: BrainDocumentRendition = {
      bodyRef: version.bodyRef!,
      brainId,
      contentHash: "evidence-hash",
      coordinateSystem: "utf8-byte",
      createdAt: NOW,
      documentId,
      documentVersionId: versionId,
      id: renditionId,
      kind: "original",
      organizationId: scope.organizationId,
    };
    const rendition = brainNormalizedRendition({
      createdAt: NOW,
      extraction: { facts: { kind: "pdf", pages: 1, pagesWithText: 1 }, truncated: false },
      original,
      text: {
        bucket: "artifact-bucket",
        byteSize: 9,
        contentType: "text/plain; charset=utf-8",
        key: brainNormalizedTextKey(original),
        sha256: "text-hash",
        versionId: "s3-version-2",
      },
    });
    const grantRecord = brainGrantPlatformRecord(grant);
    const grantClaim = makeUniqueClaimRecord(uniqueClaimRequirements(grantRecord)[0]!, NOW);
    store.put("control", {
      data: { id: scope.organizationId, status: "active" },
      itemType: "organization",
      pk: key("ORG", ORGANIZATION_ID),
      sk: key("ORG", ORGANIZATION_ID),
    } as PlatformRecord);
    for (const value of [
      brainPlatformRecord(brain),
      grantRecord,
      grantClaim,
      brainSourcePlatformRecord(source),
      brainDocumentPlatformRecord(document),
      brainDocumentVersionPlatformRecord(version),
      brainDocumentRenditionPlatformRecord(original),
      brainDocumentRenditionPlatformRecord(rendition),
    ]) {
      store.put("control", value as PlatformRecord);
    }
    store.put(
      "execution",
      artifact(ARTIFACT_ONE_ID, {
        metadata: {
          source: {
            brainIds: [brainId],
            citations: [
              {
                brainId,
                chunkId: "chunk-1",
                documentId,
                documentVersionId: versionId,
                renditionId: rendition.id,
                sourceId,
              },
            ],
            initiatingServiceAccountId: principal.serviceAccount.data.id,
            kind: "brain-private-publication",
          },
        },
        privateAccess: "brain-authorized",
      }),
    );
    const api = dependencies(store.database);

    expect(
      getArtifact(api, principal, Schema.decodeUnknownSync(Ulid)(ARTIFACT_ONE_ID)),
    ).resolves.toMatchObject({ artifactId: ARTIFACT_ONE_ID });

    store.put(
      "control",
      brainDocumentPlatformRecord({
        ...document,
        reviewStatus: "rejected",
        updatedAt: "2026-07-25T12:00:30.000Z",
        version: 1,
      }),
    );
    expect(
      getArtifact(api, principal, Schema.decodeUnknownSync(Ulid)(ARTIFACT_ONE_ID)),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });
    store.put("control", brainDocumentPlatformRecord(document));

    store.put(
      "control",
      brainGrantPlatformRecord({
        ...grant,
        revokedAt: "2026-07-25T12:01:00.000Z",
        status: "revoked",
        updatedAt: "2026-07-25T12:01:00.000Z",
        version: 1,
      }),
    );
    expect(
      getArtifact(api, principal, Schema.decodeUnknownSync(Ulid)(ARTIFACT_ONE_ID)),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });
  });

  test("does not expose runtime-only private artifacts through service-account APIs", async () => {
    const store = makeDatabase();
    store.put(
      "execution",
      artifact(ARTIFACT_ONE_ID, {
        agentDeploymentId: RUN_ONE_ID,
        ownerServiceAccountId: null,
        privateAccess: "runtime-only",
      }),
    );
    const api = dependencies(store.database);

    expect(listArtifacts(api, principal, {})).resolves.toEqual({ artifacts: [] });
    expect(
      getArtifact(api, principal, Schema.decodeUnknownSync(Ulid)(ARTIFACT_ONE_ID)),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });
    expect(
      createArtifactAccessUrl(api, principal, Schema.decodeUnknownSync(Ulid)(ARTIFACT_ONE_ID), {}),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });
  });

  test("bounds private-artifact filtering and resumes after the scan budget", async () => {
    const store = makeDatabase();
    for (let index = 400; index < 410; index++) {
      store.put("execution", artifact(generatedUlid(index)));
    }
    store.put(
      "execution",
      artifact(ARTIFACT_ONE_ID, {
        visibility: "organization",
      }),
    );
    let artifactQueries = 0;
    const database: DynamoDatabaseService = {
      ...store.database,
      queryRecords: (table, input) => {
        artifactQueries += 1;
        return store.database.queryRecords(table, { ...input, Limit: 1 });
      },
    };
    const api = dependencies(database);

    const first = await listArtifacts(api, otherPrincipal, { limit: "1" });
    expect(first.artifacts).toEqual([]);
    expect(first.nextCursor).toBeTruthy();
    expect(artifactQueries).toBe(10);

    const second = await listArtifacts(api, otherPrincipal, {
      cursor: first.nextCursor,
      limit: "1",
    });
    expect(second.artifacts.map((value) => String(value.artifactId))).toEqual([ARTIFACT_ONE_ID]);
    expect(second.nextCursor).toBeUndefined();
    expect(artifactQueries).toBe(11);
  });
});
