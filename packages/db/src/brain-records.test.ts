import { describe, expect, it } from "bun:test";
import { Effect, Exit, Schema } from "effect";
import { Ulid } from "./ids.ts";
import { decodePlatformRecord, withCanonicalRecordKeys } from "./records/index.ts";
import { uniqueClaimRequirements } from "./unique-claims.ts";

const id = (value: string) => Schema.decodeUnknownSync(Ulid)(value);
const organizationId = id("01ARZ3NDEKTSV4RRFFQ69G5FAV");
const brainId = id("01ARZ3NDEKTSV4RRFFQ69G5FAW");
const principalId = id("01ARZ3NDEKTSV4RRFFQ69G5FAY");
const grantId = id("01ARZ3NDEKTSV4RRFFQ69G5FAZ");
const sourceId = id("01ARZ3NDEKTSV4RRFFQ69G5FB0");
const documentId = id("01ARZ3NDEKTSV4RRFFQ69G5FB1");
const versionId = id("01ARZ3NDEKTSV4RRFFQ69G5FB2");
const renditionId = id("01ARZ3NDEKTSV4RRFFQ69G5FB3");
const targetId = id("01ARZ3NDEKTSV4RRFFQ69G5FB4");
const componentId = id("01ARZ3NDEKTSV4RRFFQ69G5FB5");
const embeddingProfileId = id("01ARZ3NDEKTSV4RRFFQ69G5FB6");
const attemptId = id("01ARZ3NDEKTSV4RRFFQ69G5FB7");
const timestamp = "2026-07-30T12:00:00.000Z";

function companyBrain() {
  return withCanonicalRecordKeys({
    data: {
      createdAt: timestamp,
      createdByPrincipalId: principalId,
      id: brainId,
      kind: "company" as const,
      maintenancePolicy: {},
      name: "Engineering decisions",
      organizationId,
      ownershipGeneration: 0,
      retrievalPolicy: {},
      schemaVersion: 1,
      sensitivity: "internal" as const,
      slug: "engineering-decisions",
      status: "active" as const,
      updatedAt: timestamp,
      updatedByPrincipalId: principalId,
      version: 0,
    },
    itemType: "brain" as const,
  });
}

describe("Brain canonical records", () => {
  it("keys a company Brain and reserves its organization-scoped slug", async () => {
    const record = companyBrain();

    expect(record.pk).toBe(`ORG#${organizationId}`);
    expect(record.sk).toBe(`BRAIN#${brainId}`);
    expect(uniqueClaimRequirements(record)).toMatchObject([
      {
        namespace: `organization:${organizationId}:brain-slug`,
        value: "engineering-decisions",
      },
    ]);
    expect(Exit.isSuccess(await Effect.runPromiseExit(decodePlatformRecord(record)))).toBe(true);
  });

  it("requires member-private ownership and forbids a singular company owner", async () => {
    const companyWithOwner = withCanonicalRecordKeys({
      ...companyBrain(),
      data: { ...companyBrain().data, ownerPrincipalId: principalId },
    });
    const privateWithoutOwner = withCanonicalRecordKeys({
      ...companyBrain(),
      data: {
        ...companyBrain().data,
        kind: "member-private" as const,
        ownershipGeneration: 1,
      },
    });

    expect(
      Exit.isFailure(await Effect.runPromiseExit(decodePlatformRecord(companyWithOwner))),
    ).toBe(true);
    expect(
      Exit.isFailure(await Effect.runPromiseExit(decodePlatformRecord(privateWithoutOwner))),
    ).toBe(true);
  });

  it("indexes active grants by target and binds member-private delegation generations", async () => {
    const grant = withCanonicalRecordKeys({
      data: {
        agentDefinitionId: principalId,
        brainId,
        brainKind: "member-private" as const,
        createdAt: timestamp,
        grantedByPrincipalId: principalId,
        id: grantId,
        organizationId,
        ownershipGeneration: 4,
        permission: "read-write" as const,
        status: "active" as const,
        targetEnvironmentId: documentId,
        targetProjectId: sourceId,
        targetType: "agent-definition" as const,
        updatedAt: timestamp,
        version: 0,
      },
      itemType: "brain-grant" as const,
    });

    expect(grant.pk).toBe(`ORG#${organizationId}#BRAIN#${brainId}`);
    expect(grant.gsi1pk).toBe(`ORG#${organizationId}#AGENT#${principalId}#BRAIN-GRANTS`);
    expect(uniqueClaimRequirements(grant)).toMatchObject([
      {
        namespace: `organization:${organizationId}:brain:${brainId}:grant`,
        value: `agent-definition:${principalId}`,
      },
    ]);
    expect(Exit.isSuccess(await Effect.runPromiseExit(decodePlatformRecord(grant)))).toBe(true);

    const staleShape = withCanonicalRecordKeys({
      ...grant,
      data: { ...grant.data, ownershipGeneration: undefined },
    });
    expect(Exit.isFailure(await Effect.runPromiseExit(decodePlatformRecord(staleShape)))).toBe(
      true,
    );
  });

  it("indexes deployment mounts and reserves one active mount per Brain", async () => {
    const mount = withCanonicalRecordKeys({
      data: {
        agentDefinitionId: principalId,
        agentDeploymentId: sourceId,
        brainId,
        brainKind: "company" as const,
        createdAt: timestamp,
        grantedByPrincipalId: principalId,
        id: grantId,
        organizationId,
        permission: "read" as const,
        environmentId: documentId,
        projectId: sourceId,
        status: "active" as const,
        updatedAt: timestamp,
        version: 0,
      },
      itemType: "brain-deployment-mount" as const,
    });

    expect(mount.pk).toBe(`ORG#${organizationId}#BRAIN#${brainId}`);
    expect(mount.gsi1pk).toBe(`ORG#${organizationId}#AGENT-DEPLOYMENT#${sourceId}#BRAIN-MOUNTS`);
    expect(uniqueClaimRequirements(mount)).toMatchObject([
      {
        namespace: `organization:${organizationId}:agent-deployment:${sourceId}:brain-mount`,
        value: brainId,
      },
    ]);
    expect(Exit.isSuccess(await Effect.runPromiseExit(decodePlatformRecord(mount)))).toBe(true);
  });

  it("keeps stable documents in the Brain aggregate and immutable versions in the document aggregate", async () => {
    const document = withCanonicalRecordKeys({
      data: {
        brainId,
        createdAt: timestamp,
        currentContentVersionId: versionId,
        currentEnvelopeHash: "sha256:envelope",
        currentSourceOrder: 1,
        currentVersionId: versionId,
        externalItemIdentity: "github:repo:decision-42",
        id: documentId,
        lifecycle: "active" as const,
        organizationId,
        projectionGeneration: 0,
        reviewStatus: "approved" as const,
        sensitivity: "internal" as const,
        sourceId,
        updatedAt: timestamp,
        version: 0,
      },
      itemType: "brain-document" as const,
    });
    const version = withCanonicalRecordKeys({
      data: {
        bodyRef: {
          bucket: "brain-content",
          byteSize: 12,
          contentType: "text/markdown",
          key: `organizations/${organizationId}/brains/${brainId}/${versionId}`,
          sha256: "sha256:content",
          versionId: "s3-version-1",
        },
        brainId,
        byteSize: 12,
        contentHash: "sha256:content",
        createdAt: timestamp,
        documentId,
        envelopeHash: "sha256:envelope",
        id: versionId,
        kind: "content" as const,
        mediaType: "text/markdown",
        organizationId,
        originalRenditionId: renditionId,
        sourceId,
        sourceOrder: 1,
      },
      itemType: "brain-document-version" as const,
    });

    expect(document.pk).toBe(`ORG#${organizationId}#BRAIN#${brainId}`);
    expect(version.pk).toBe(`ORG#${organizationId}#DOCUMENT#${documentId}`);
    expect(uniqueClaimRequirements(document)).toMatchObject([
      {
        namespace: `organization:${organizationId}:brain-source:${sourceId}:document`,
        value: "github:repo:decision-42",
      },
    ]);
    expect(Exit.isSuccess(await Effect.runPromiseExit(decodePlatformRecord(document)))).toBe(true);
    expect(Exit.isSuccess(await Effect.runPromiseExit(decodePlatformRecord(version)))).toBe(true);
  });

  it("rejects mutable content references and body-bearing lifecycle markers", async () => {
    const lifecycle = withCanonicalRecordKeys({
      data: {
        bodyRef: {
          bucket: "brain-content",
          byteSize: 12,
          contentType: "text/plain",
          key: "mutable-key",
          sha256: "sha256:content",
        },
        brainId,
        byteSize: 12,
        contentHash: "sha256:content",
        createdAt: timestamp,
        documentId,
        envelopeHash: "sha256:envelope",
        id: versionId,
        kind: "tombstone" as const,
        mediaType: "text/plain",
        organizationId,
        sourceId,
        sourceOrder: 2,
      },
      itemType: "brain-document-version" as const,
    });

    expect(Exit.isFailure(await Effect.runPromiseExit(decodePlatformRecord(lifecycle)))).toBe(true);
  });

  it("keeps one organization Brain search target with no fallback or dual-write", async () => {
    const target = {
      components: [{ componentId, kind: "dense" as const }],
      embeddingProfileId,
      location: { openSearchIndex: "brain-org" },
      providerId: "aws-native" as const,
      schemaGeneration: 1,
      targetId,
    };
    const placement = withCanonicalRecordKeys({
      data: {
        createdAt: timestamp,
        generation: 1,
        organizationId,
        phase: "active" as const,
        readTarget: target,
        updatedAt: timestamp,
        version: 0,
        writeTarget: target,
      },
      itemType: "brain-search-placement" as const,
    });

    expect(placement.pk).toBe(`ORG#${organizationId}`);
    expect(placement.sk).toBe(`BRAIN-SEARCH-PLACEMENT#${organizationId}`);
    expect(Exit.isSuccess(await Effect.runPromiseExit(decodePlatformRecord(placement)))).toBe(true);

    const splitTarget = withCanonicalRecordKeys({
      ...placement,
      data: {
        ...placement.data,
        writeTarget: { ...target, targetId: componentId },
      },
    });
    expect(Exit.isFailure(await Effect.runPromiseExit(decodePlatformRecord(splitTarget)))).toBe(
      true,
    );
  });

  it("requires every provider component before publishing ready Brain index state", async () => {
    const state = withCanonicalRecordKeys({
      data: {
        attemptId,
        brainId,
        chunkIds: ["chunk-1"],
        components: [
          {
            componentId,
            kind: "dense" as const,
            status: "ready" as const,
            updatedAt: timestamp,
          },
        ],
        contentHash: "sha256:content",
        createdAt: timestamp,
        documentId,
        documentVersionId: versionId,
        embeddingProfileId,
        organizationId,
        placementGeneration: 1,
        projectionGeneration: 2,
        provider: "aws-native" as const,
        schemaGeneration: 1,
        sourceId,
        status: "ready" as const,
        synchronizedAt: timestamp,
        targetId,
        updatedAt: timestamp,
        version: 0,
      },
      itemType: "brain-index-state" as const,
    });

    expect(state.pk).toBe(`ORG#${organizationId}#DOCUMENT#${documentId}`);
    expect(Exit.isSuccess(await Effect.runPromiseExit(decodePlatformRecord(state)))).toBe(true);

    const partial = withCanonicalRecordKeys({
      ...state,
      data: {
        ...state.data,
        components: [
          {
            componentId,
            kind: "dense" as const,
            status: "pending" as const,
            updatedAt: timestamp,
          },
        ],
      },
    });
    expect(Exit.isFailure(await Effect.runPromiseExit(decodePlatformRecord(partial)))).toBe(true);
  });

  it("queues target-bound Brain index work and stores content-free retrieval telemetry", async () => {
    const job = withCanonicalRecordKeys({
      data: {
        attempt: 0,
        brainId,
        components: [{ componentId, kind: "dense" as const, status: "pending" as const }],
        createdAt: timestamp,
        documentId,
        documentVersionId: versionId,
        embeddingProfileId,
        expectedContentHash: "sha256:content",
        expectedProjectionGeneration: 2,
        id: attemptId,
        idempotencyKey: "document-version:2",
        nextDueAt: timestamp,
        operation: "index" as const,
        organizationId,
        placementGeneration: 1,
        priority: 10,
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
    });
    const retrieval = withCanonicalRecordKeys({
      data: {
        brainId,
        chunkId: "chunk-1",
        createdAt: timestamp,
        documentId,
        documentVersionId: versionId,
        id: componentId,
        injected: true,
        organizationId,
        provider: "aws-native" as const,
        purpose: "brain.search",
        queryAttemptId: attemptId,
        rank: 1,
        renditionId,
        score: 0.9,
        sourceId,
        version: 0,
      },
      itemType: "brain-retrieval" as const,
    });

    expect(job.pk).toBe(`ORG#${organizationId}#DOCUMENT#${documentId}`);
    expect(job.gsi1pk).toMatch(/^QUEUE#BRAIN-INDEX-JOB#queued#/u);
    expect(retrieval.pk).toBe(`ORG#${organizationId}#QUERY-ATTEMPT#${attemptId}`);
    expect(retrieval.gsi1pk).toBe(`ORG#${organizationId}#BRAIN-TELEMETRY#BRAIN-RETRIEVAL`);
    expect(Exit.isSuccess(await Effect.runPromiseExit(decodePlatformRecord(job)))).toBe(true);
    expect(Exit.isSuccess(await Effect.runPromiseExit(decodePlatformRecord(retrieval)))).toBe(true);
  });

  it("reserves deterministic entity aliases and indexes bounded graph directions", async () => {
    const entity = withCanonicalRecordKeys({
      data: {
        brainId,
        canonicalName: "Acme Corp",
        createdAt: timestamp,
        externalIdentifiers: { crm: "acme" },
        id: componentId,
        kind: "company" as const,
        normalizedAliases: ["acme", "acme corp"],
        organizationId,
        reviewStatus: "approved" as const,
        status: "active" as const,
        updatedAt: timestamp,
        version: 0,
      },
      itemType: "brain-entity" as const,
    });
    const edge = withCanonicalRecordKeys({
      data: {
        brainId,
        confidence: 1,
        createdAt: timestamp,
        documentVersionId: versionId,
        evidence: { end: 12, start: 0 },
        extractionMethod: "deterministic" as const,
        from: { id: componentId, kind: "entity" as const },
        id: attemptId,
        lifecycle: "active" as const,
        organizationId,
        relation: "mentioned_in",
        renditionId,
        reviewStatus: "approved" as const,
        to: { id: documentId, kind: "document" as const },
        updatedAt: timestamp,
        version: 0,
      },
      itemType: "brain-edge" as const,
    });

    expect(uniqueClaimRequirements(entity).map((claim) => claim.value)).toEqual([
      "acme",
      "acme corp",
    ]);
    expect(edge.gsi1pk).toBe(
      `ORG#${organizationId}#BRAIN#${brainId}#GRAPH#entity#${componentId}#OUTGOING`,
    );
    expect(edge.gsi2pk).toBe(
      `ORG#${organizationId}#BRAIN#${brainId}#GRAPH#document#${documentId}#INCOMING`,
    );
    expect(Exit.isSuccess(await Effect.runPromiseExit(decodePlatformRecord(edge)))).toBe(true);
  });

  it("requires immutable rendition objects and exact ticket TTLs", async () => {
    const rendition = withCanonicalRecordKeys({
      data: {
        bodyRef: {
          bucket: "brain-content",
          byteSize: 12,
          contentType: "text/plain",
          key: "normalized-key",
          sha256: "sha256:normalized",
          versionId: "s3-version-2",
        },
        brainId,
        contentHash: "sha256:normalized",
        coordinateSystem: "utf8-byte" as const,
        createdAt: timestamp,
        documentId,
        documentVersionId: versionId,
        id: renditionId,
        kind: "normalized" as const,
        organizationId,
      },
      itemType: "brain-document-rendition" as const,
    });
    const expiresAt = "2026-07-30T12:05:00.000Z";
    const ticket = withCanonicalRecordKeys({
      data: {
        brainId,
        createdAt: timestamp,
        createdByPrincipalId: principalId,
        expectedByteSize: 12,
        expectedContentHash: "sha256:content",
        expiresAt,
        id: grantId,
        mediaType: "text/plain",
        objectKey: "ticket-key",
        organizationId,
        sourceId,
        status: "issued" as const,
        updatedAt: timestamp,
        version: 0,
      },
      itemType: "brain-upload-ticket" as const,
      ttl: Math.floor(Date.parse(expiresAt) / 1_000),
    });

    expect(rendition.pk).toBe(`ORG#${organizationId}#DOCUMENT-VERSION#${versionId}`);
    expect(Exit.isSuccess(await Effect.runPromiseExit(decodePlatformRecord(rendition)))).toBe(true);
    expect(Exit.isSuccess(await Effect.runPromiseExit(decodePlatformRecord(ticket)))).toBe(true);
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(decodePlatformRecord({ ...ticket, ttl: ticket.ttl! + 1 })),
      ),
    ).toBe(true);
  });

  it("queues generation-bound Brain erasure and requires complete absence evidence", async () => {
    const pending = withCanonicalRecordKeys({
      data: {
        brainId,
        contentVerificationCount: 0,
        createdAt: timestamp,
        erasureGeneration: 1,
        id: attemptId,
        nextDueAt: timestamp,
        organizationId,
        phase: "draining" as const,
        priority: 0,
        requestedByPrincipalId: principalId,
        status: "pending" as const,
        updatedAt: timestamp,
        version: 0,
      },
      itemType: "brain-erasure-job" as const,
    });
    expect(pending.pk).toBe(`ORG#${organizationId}#BRAIN#${brainId}`);
    expect(pending.gsi1pk).toMatch(/^QUEUE#BRAIN-ERASURE-JOB#pending#/u);
    expect(Exit.isSuccess(await Effect.runPromiseExit(decodePlatformRecord(pending)))).toBe(true);
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(
          decodePlatformRecord({
            ...pending,
            data: {
              ...pending.data,
              completedAt: timestamp,
              phase: "verifying",
              status: "completed",
              version: 1,
            },
          }),
        ),
      ),
    ).toBe(true);
    const failed = withCanonicalRecordKeys({
      ...pending,
      data: {
        ...pending.data,
        error: "Access Denied",
        failedAttempts: 8,
        status: "failed" as const,
      },
    });
    expect(failed.gsi1pk).toMatch(/^QUEUE#BRAIN-ERASURE-JOB#failed#/u);
    expect(Exit.isSuccess(await Effect.runPromiseExit(decodePlatformRecord(failed)))).toBe(true);
    const { error: _error, ...withoutError } = failed.data;
    expect(
      Exit.isFailure(
        await Effect.runPromiseExit(decodePlatformRecord({ ...failed, data: withoutError })),
      ),
    ).toBe(true);
  });

  it("scopes source revision uniqueness to the external source item", () => {
    const revisionClaim = (externalItemIdentity: string) =>
      withCanonicalRecordKeys({
        data: {
          brainId,
          createdAt: timestamp,
          documentId,
          externalItemIdentity,
          fingerprint: `fingerprint-${externalItemIdentity}`,
          id: attemptId,
          organizationId,
          revisionKey: "shared-commit-sha",
          sourceId,
          versionId,
        },
        itemType: "brain-source-revision-claim" as const,
      });

    const first = uniqueClaimRequirements(revisionClaim(" docs/first.md "))[0]!;
    const second = uniqueClaimRequirements(revisionClaim("docs/second.md"))[0]!;
    expect(first.value).toBe("shared-commit-sha");
    expect(first.namespace).not.toBe(second.namespace);
    expect(first.namespace).toContain(":item:docs/first.md:revision");
  });
});
