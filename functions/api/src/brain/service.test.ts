import { describe, expect, jest, test } from "bun:test";
import type {
  Brain,
  BrainDocumentCaptureResult,
  BrainGrant,
  BrainRepository,
  BrainSource,
  BrainUploadTicket,
} from "@deployments-ai/brains";
import { PersistenceError } from "@deployments-ai/db";
import type { ApiIdentity } from "../api-service-contracts.ts";
import {
  brain,
  brainId,
  contentHash,
  credentialId,
  database,
  environmentId,
  invocation,
  liveHumanRecords,
  organizationId,
  ownerGrant,
  ownerId,
  principalId,
  projectId,
  record,
  repository,
  service,
  serviceAccountId,
  source,
  sourceId,
  timestamp,
  uploadTicket,
} from "./service.fixture.ts";
const queryAttemptId = "01ARZ3NDEKTSV4RRFFQ69G5FBN";

describe("Brain API service", () => {
  test("searches only an explicitly authorized Brain set and rechecks disclosure", async () => {
    let disclosedBrainId: string | undefined;
    const result = await service({
      brainQueryRuntime: {
        ask: async () => ({ claims: [], gaps: [], queryAttemptId, usedCitations: [] }),
        search: async (input) => {
          expect(input.brains.map((item) => item.id)).toEqual([brainId]);
          expect(input.telemetryContext).toEqual({
            environmentId,
            operationId: "brain-search-1",
            projectId,
            purpose: "brain-api",
            workspaceId: undefined,
          });
          disclosedBrainId = (await input.authorizeDisclosure(brainId))?.id;
          return { queryAttemptId, results: [] };
        },
      },
    }).invoke(
      "searchBrains",
      invocation({
        body: { brainIds: [brainId], query: "Why?" },
        identity: {
          ...invocation().identity,
          environmentIds: [environmentId],
          projectIds: [projectId],
        },
        idempotencyKey: "brain-search-1",
        params: {},
      }),
    );

    expect(result).toEqual({ queryAttemptId, results: [] });
    expect(disclosedBrainId).toBe(brainId);
  });

  test("fails a stalled Brain ask with a retryable timeout before the 29 s route timeout", async () => {
    const reached = Promise.withResolvers<void>();
    jest.useFakeTimers();
    try {
      const answer = service({
        brainQueryRuntime: {
          ask: async ({ signal }) => {
            reached.resolve();
            if (!signal) throw new Error("The ask ran without a deadline.");
            const { promise, reject } = Promise.withResolvers<never>();
            signal.addEventListener("abort", () => reject(signal.reason));
            return promise;
          },
          search: async () => ({ queryAttemptId, results: [] }),
        },
      }).invoke(
        "askBrains",
        invocation({
          body: { brainIds: [brainId], question: "Why?" },
          identity: {
            ...invocation().identity,
            environmentIds: [environmentId],
            projectIds: [projectId],
          },
          idempotencyKey: "brain-ask-stalled",
          params: {},
        }),
      );
      const routeTimeout = Promise.withResolvers<never>();
      setTimeout(
        () => routeTimeout.reject(new Error("The ask outlived the 29 s route timeout.")),
        29_000,
      );
      const outcome = Promise.race([answer, routeTimeout.promise]).then(
        () => "answered",
        (error: unknown) => error,
      );
      await reached.promise;
      jest.advanceTimersByTime(28_000);
      const drained = Promise.withResolvers<void>();
      setImmediate(drained.resolve);
      await drained.promise;
      jest.advanceTimersByTime(1_000);

      expect(await outcome).toMatchObject({ code: "brain_query_timeout", status: 504 });
    } finally {
      jest.useRealTimers();
    }
  }, 2_000);

  test("rejects Brain model calls without one billable project and environment scope", async () => {
    let invoked = false;
    const runtime = {
      ask: async () => {
        invoked = true;
        return { claims: [], gaps: [], queryAttemptId, usedCitations: [] };
      },
      search: async () => {
        invoked = true;
        return { queryAttemptId, results: [] };
      },
    };

    for (const identity of [
      invocation().identity,
      { ...invocation().identity, environmentIds: "*" as const, projectIds: "*" as const },
      {
        ...invocation().identity,
        environmentIds: [environmentId, brainId],
        projectIds: [projectId, sourceId],
      },
    ]) {
      expect(
        service({ brainQueryRuntime: runtime }).invoke(
          "searchBrains",
          invocation({
            body: { brainIds: [brainId], query: "Why?" },
            identity,
            params: {},
          }),
        ),
      ).rejects.toMatchObject({
        code: "brain_query_scope_required",
        kind: "invalid-input",
      } satisfies Partial<PersistenceError>);
    }

    expect(invoked).toBe(false);
  });

  test("fails closed when Brain search has no selected runtime", async () => {
    expect(
      service().invoke(
        "searchBrains",
        invocation({
          body: { brainIds: [brainId], query: "Why?" },
          params: {},
        }),
      ),
    ).rejects.toMatchObject({
      code: "brain_search_unavailable",
      kind: "internal",
    });
  });

  test("creates a member-private Brain and its generation-bound owner grant together", async () => {
    let captured: Parameters<BrainRepository["createWithOwner"]>[0] | undefined;
    const result = await service({
      repository: repository({
        createWithOwner: async (input) => {
          captured = input;
          return input.brain;
        },
      }),
    }).invoke(
      "createBrain",
      invocation({
        body: { kind: "member-private", name: "My work", slug: "my-work" },
        params: {},
      }),
    );

    expect(result).toMatchObject({
      kind: "member-private",
      ownerPrincipalId: principalId,
      ownershipGeneration: 1,
    });
    expect(captured?.ownerGrant).toMatchObject({
      ownershipGeneration: 1,
      permission: "owner",
      target: { principalId, type: "principal" },
    });
  });

  test("revalidates live principal membership at the read disclosure boundary", async () => {
    expect(
      service({ database: database(liveHumanRecords("removed")) }).invoke("getBrain", invocation()),
    ).rejects.toMatchObject({
      code: "brain_caller_inactive",
      kind: "forbidden",
    } satisfies Partial<PersistenceError>);
  });

  test("suppresses member-private service reads when the current owner is inactive", async () => {
    const privateBrain: Brain = {
      ...brain,
      kind: "member-private",
      ownerPrincipalId: ownerId,
      ownershipGeneration: 3,
    };
    const serviceGrant: BrainGrant = {
      ...ownerGrant,
      brainKind: "member-private",
      ownershipGeneration: 3,
      permission: "read",
      target: {
        environmentId,
        projectId,
        serviceAccountId,
        type: "service-account",
      },
    };
    const records = {
      [`ORG#${organizationId}|ORG#${organizationId}`]: record("organization", {
        id: organizationId,
        status: "active",
      }),
      [`PRINCIPAL#${ownerId}|PRINCIPAL#${ownerId}`]: record("principal", {
        id: ownerId,
        kind: "human",
        status: "disabled",
      }),
      [`ORG#${organizationId}|ORGANIZATION-MEMBER#${ownerId}`]: record("organization-member", {
        organizationId,
        principalId: ownerId,
        role: "owner",
        status: "active",
      }),
      [`ORG#${organizationId}#ENV#${environmentId}|SERVICE-ACCOUNT#${serviceAccountId}`]: record(
        "service-account",
        {
          environmentId,
          id: serviceAccountId,
          organizationId,
          projectId,
          status: "active",
        },
      ),
      [`ORG#${organizationId}#ENV#${environmentId}|API-CREDENTIAL#${credentialId}`]: record(
        "api-credential",
        {
          environmentId,
          id: credentialId,
          organizationId,
          projectId,
          serviceAccountId,
          status: "active",
        },
      ),
    };
    const serviceIdentity = {
      apiCredentialId: credentialId,
      authentication: "api-credential",
      environmentIds: [environmentId],
      organizationIds: [organizationId],
      principalId: serviceAccountId,
      projectIds: [projectId],
      scopes: ["brains:read"],
    } as const satisfies ApiIdentity;

    expect(
      service({
        database: database(records),
        repository: repository({
          findActiveGrant: async () => serviceGrant,
          get: async () => privateBrain,
        }),
      }).invoke("getBrain", invocation({ identity: serviceIdentity })),
    ).rejects.toMatchObject({
      code: "brain_owner_inactive",
      kind: "forbidden",
    });
  });

  test("does not persist expectedVersion as Brain state", async () => {
    let updated: Brain | undefined;
    await service({
      repository: repository({
        update: async ({ brain: value }) => {
          updated = value;
          return value;
        },
      }),
    }).invoke(
      "updateBrain",
      invocation({ body: { expectedVersion: 0, name: "Platform knowledge" } }),
    );

    expect(updated).toMatchObject({ name: "Platform knowledge", version: 1 });
    expect(updated).not.toHaveProperty("expectedVersion");
  });

  test("creates platform uploads and the selected GitHub managed source", async () => {
    let created: BrainSource | undefined;
    const result = await service(
      {
        repository: repository({
          createSource: async ({ source: value }) => {
            created = value;
            return value;
          },
        }),
      },
      [sourceId, "01ARZ3NDEKTSV4RRFFQ69G5FB6"],
    ).invoke("createBrainSource", invocation({ body: { kind: "upload", name: "Uploads" } }));

    expect(result).toMatchObject({ brainId, kind: "upload", name: "Uploads" });
    expect(created).toMatchObject({
      createdByPrincipalId: principalId,
      status: "active",
    });
    const github = await service({
      repository: repository({ createSource: async ({ source: value }) => value }),
    }).invoke(
      "createBrainSource",
      invocation({
        body: {
          configuration: { owner: "deployments-ai", repository: "platform" },
          connectionId: credentialId,
          environmentId,
          kind: "github",
          name: "GitHub",
          projectId,
        },
      }),
    );
    expect(github).toMatchObject({
      configuration: { owner: "deployments-ai", repository: "platform" },
      connectionId: credentialId,
      kind: "github",
    });
  });

  test("captures a source lifecycle marker as an immutable cited revision", async () => {
    let captured: BrainDocumentCaptureResult | undefined;
    await service(
      {
        repository: repository({
          captureDocumentRevision: async ({ document, version }) => {
            captured = { document, version };
            return captured;
          },
          getSource: async () => source,
        }),
      },
      [
        "01ARZ3NDEKTSV4RRFFQ69G5FB6",
        "01ARZ3NDEKTSV4RRFFQ69G5FB7",
        "01ARZ3NDEKTSV4RRFFQ69G5FB8",
        "01ARZ3NDEKTSV4RRFFQ69G5FB9",
      ],
    ).invoke(
      "captureBrainDocument",
      invocation({
        body: {
          externalItemIdentity: "decision-42",
          kind: "archive",
          sourceOrder: 5,
          sourceRevision: "revision-5",
          transitionReason: "Archived upstream",
        },
        idempotencyKey: "capture-5",
        params: { brainId, sourceId },
      }),
    );

    expect(captured?.document).toMatchObject({
      currentSourceOrder: 5,
      externalItemIdentity: "decision-42",
      lifecycle: "archived",
    });
    expect(captured?.version).toMatchObject({
      kind: "archive",
      sourceOrder: 5,
      sourceRevision: "revision-5",
      transitionReason: "Archived upstream",
    });
  });

  test("rejects a reused source revision with a different evidence envelope", async () => {
    expect(
      service({
        repository: repository({
          findSourceRevisionClaim: async () => ({
            brainId,
            createdAt: timestamp,
            documentId: "01ARZ3NDEKTSV4RRFFQ69G5FB6",
            externalItemIdentity: "decision-42",
            fingerprint: "different-envelope",
            id: "01ARZ3NDEKTSV4RRFFQ69G5FB7",
            organizationId,
            revisionKey: "revision-5",
            sourceId,
            versionId: "01ARZ3NDEKTSV4RRFFQ69G5FB8",
          }),
          getSource: async () => source,
        }),
      }).invoke(
        "captureBrainDocument",
        invocation({
          body: {
            externalItemIdentity: "decision-42",
            kind: "archive",
            sourceRevision: "revision-5",
          },
          params: { brainId, sourceId },
        }),
      ),
    ).rejects.toMatchObject({
      code: "brain_revision_idempotency_conflict",
      kind: "conflict",
    });
  });

  test("issues a caller-bound controlled upload ticket", async () => {
    let issued: BrainUploadTicket | undefined;
    const result = await service(
      {
        repository: repository({
          getSource: async () => source,
          issueUploadTicket: async ({ ticket }) => {
            issued = ticket;
            return ticket;
          },
        }),
      },
      ["01ARZ3NDEKTSV4RRFFQ69G5FB6", "01ARZ3NDEKTSV4RRFFQ69G5FB7"],
    ).invoke(
      "createBrainUploadTicket",
      invocation({
        body: {
          expectedByteSize: 3,
          expectedContentHash: contentHash,
          mediaType: "text/plain",
        },
        params: { brainId, sourceId },
      }),
    );

    expect(issued).toMatchObject({
      createdByPrincipalId: principalId,
      expectedByteSize: 3,
      sourceId,
      status: "issued",
    });
    expect(result).toMatchObject({
      uploadPath: `/v1/brains/${brainId}/sources/${sourceId}/uploads/${issued?.id}/content`,
    });
    expect(result).not.toHaveProperty("createdByPrincipalId");
    expect(result).not.toHaveProperty("objectKey");
  });

  test("streams an exact upload envelope through an active lease before completion", async () => {
    let completed: BrainUploadTicket | undefined;
    const result = await service(
      {
        contentBucket: "content-bucket",
        contentKmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/content",
        contentUploader: {
          presign: async () => ({ headers: {}, url: "https://storage.example/upload" }),
          upload: async (input) => ({
            bucket: input.bucket,
            byteSize: input.contentLength,
            contentType: input.contentType,
            key: input.objectKey,
            sha256: input.expectedContentHash,
            versionId: "s3-version-1",
          }),
          verify: async () => undefined,
        },
        repository: repository({
          beginUpload: async ({ next }) => next,
          completeUpload: async ({ next }) => {
            completed = next;
            return next;
          },
          getSource: async () => source,
          getUploadTicket: async () => uploadTicket,
        }),
      },
      ["01ARZ3NDEKTSV4RRFFQ69G5FB7"],
    ).invoke(
      "uploadBrainContent",
      invocation({
        params: { brainId, sourceId, ticketId: uploadTicket.id },
        rawRequest: new Request("https://api.example/upload", {
          body: "abc",
          headers: { "content-length": "3", "content-type": "text/plain" },
          method: "PUT",
        }),
      }),
    );

    expect(result).toMatchObject({ status: "completed", version: 2 });
    expect(result).not.toHaveProperty("createdByPrincipalId");
    expect(result).not.toHaveProperty("objectKey");
    expect(completed?.bodyRef).toMatchObject({ versionId: "s3-version-1" });
  });

  test("consumes the exact completed ticket in the document revision transaction", async () => {
    const completedTicket: BrainUploadTicket = {
      ...uploadTicket,
      bodyRef: {
        bucket: "content-bucket",
        byteSize: 3,
        contentType: "text/plain",
        key: uploadTicket.objectKey,
        sha256: contentHash,
        versionId: "s3-version-1",
      },
      completedAt: timestamp,
      status: "completed",
      version: 2,
    };
    let capture: Parameters<BrainRepository["captureDocumentRevision"]>[0] | undefined;
    const result = await service(
      {
        repository: repository({
          captureDocumentRevision: async (input) => {
            capture = input;
            return {
              document: input.document,
              ...(input.rendition ? { rendition: input.rendition } : {}),
              version: input.version,
            };
          },
          getSource: async () => source,
          getUploadTicket: async () => completedTicket,
        }),
      },
      [
        "01ARZ3NDEKTSV4RRFFQ69G5FB7",
        "01ARZ3NDEKTSV4RRFFQ69G5FB8",
        "01ARZ3NDEKTSV4RRFFQ69G5FB9",
        "01ARZ3NDEKTSV4RRFFQ69G5FBA",
        "01ARZ3NDEKTSV4RRFFQ69G5FBB",
      ],
    ).invoke(
      "captureBrainDocument",
      invocation({
        body: {
          completedUploadTicketId: completedTicket.id,
          externalItemIdentity: "decision-43",
          kind: "content",
          mediaType: "text/plain",
          sourceRevision: "revision-content-1",
        },
        params: { brainId, sourceId },
      }),
    );

    expect(capture?.version).toMatchObject({
      bodyRef: { versionId: "s3-version-1" },
      byteSize: 3,
      contentHash,
      kind: "content",
      mediaType: "text/plain",
      originalRenditionId: capture?.rendition?.id,
    });
    expect(capture?.uploadTicket?.next).toMatchObject({
      documentId: capture?.document.id,
      documentVersionId: capture?.version.id,
      status: "consumed",
      version: 3,
    });
    expect(capture?.rendition).toMatchObject({
      bodyRef: { versionId: "s3-version-1" },
      contentHash,
      documentVersionId: capture?.version.id,
      kind: "original",
    });
    expect(capture?.document.currentContentVersionId).toBe(capture?.version.id);
    expect(result).not.toHaveProperty("rendition");
  });

  test("restores retained evidence with a new projection generation and citable content pointer", async () => {
    const documentId = "01ARZ3NDEKTSV4RRFFQ69G5FBC";
    const retainedVersionId = "01ARZ3NDEKTSV4RRFFQ69G5FBD";
    const retainedRenditionId = "01ARZ3NDEKTSV4RRFFQ69G5FBE";
    const previous = {
      brainId,
      createdAt: timestamp,
      currentContentVersionId: retainedVersionId,
      currentEnvelopeHash: "old-envelope",
      currentSourceOrder: 1,
      currentVersionId: retainedVersionId,
      externalItemIdentity: "decision-restored",
      id: documentId,
      lifecycle: "deleted" as const,
      organizationId,
      projectionGeneration: 4,
      reviewStatus: "approved" as const,
      sensitivity: "internal" as const,
      sourceId,
      updatedAt: timestamp,
      version: 2,
    };
    const retainedVersion = {
      bodyRef: {
        bucket: "content-bucket",
        byteSize: 3,
        contentType: "text/plain",
        key: `organizations/${organizationId}/brains/${brainId}/retained`,
        sha256: contentHash,
        versionId: "s3-retained",
      },
      brainId,
      byteSize: 3,
      contentHash,
      createdAt: timestamp,
      documentId,
      envelopeHash: "retained-envelope",
      id: retainedVersionId,
      kind: "content" as const,
      mediaType: "text/plain",
      organizationId,
      originalRenditionId: retainedRenditionId,
      sourceId,
      sourceOrder: 1,
    };
    const retainedRendition = {
      bodyRef: retainedVersion.bodyRef,
      brainId,
      contentHash,
      coordinateSystem: "utf8-byte" as const,
      createdAt: timestamp,
      documentId,
      documentVersionId: retainedVersionId,
      id: retainedRenditionId,
      kind: "original" as const,
      organizationId,
    };
    let capture: Parameters<BrainRepository["captureDocumentRevision"]>[0] | undefined;
    await service(
      {
        repository: repository({
          captureDocumentRevision: async (input) => {
            capture = input;
            return { document: input.document, version: input.version };
          },
          findDocumentBySourceIdentity: async () => previous,
          getDocumentRendition: async () => retainedRendition,
          getDocumentVersion: async () => retainedVersion,
          getSource: async () => source,
        }),
      },
      ["01ARZ3NDEKTSV4RRFFQ69G5FBF", "01ARZ3NDEKTSV4RRFFQ69G5FBG", "01ARZ3NDEKTSV4RRFFQ69G5FBH"],
    ).invoke(
      "captureBrainDocument",
      invocation({
        body: {
          externalItemIdentity: previous.externalItemIdentity,
          kind: "restore",
          restoredContentVersionId: retainedVersionId,
          sourceOrder: 2,
          sourceRevision: "restore-2",
        },
        params: { brainId, sourceId },
      }),
    );

    expect(capture?.document).toMatchObject({
      currentContentVersionId: retainedVersionId,
      lifecycle: "active",
      projectionGeneration: 5,
      version: 3,
    });
    expect(capture?.version).toMatchObject({
      kind: "restore",
      restoredContentVersionId: retainedVersionId,
    });
    expect(capture?.indexEvidence).toEqual({
      rendition: retainedRendition,
      version: retainedVersion,
    });
  });

  test("resolves curator review with optimistic versioning and human attribution", async () => {
    const reviewItem = {
      brainId,
      createdAt: timestamp,
      id: "01ARZ3NDEKTSV4RRFFQ69G5FBJ",
      kind: "entity-merge" as const,
      organizationId,
      proposal: {
        candidateEntityIds: ["01ARZ3NDEKTSV4RRFFQ69G5FBK", "01ARZ3NDEKTSV4RRFFQ69G5FBL"],
      },
      reason: "Two deterministic aliases need a curator decision.",
      status: "open" as const,
      updatedAt: timestamp,
      version: 0,
    };
    let resolved: Parameters<BrainRepository["resolveReviewItem"]>[0] | undefined;
    const result = await service(
      {
        repository: repository({
          getReviewItem: async () => reviewItem,
          resolveReviewItem: async (input) => {
            resolved = input;
            return input.reviewItem;
          },
        }),
      },
      ["01ARZ3NDEKTSV4RRFFQ69G5FBM"],
    ).invoke(
      "resolveBrainReviewItem",
      invocation({
        body: {
          decision: "merge",
          expectedVersion: 0,
          targetEntityId: "01ARZ3NDEKTSV4RRFFQ69G5FBK",
        },
        params: { brainId, reviewItemId: reviewItem.id },
      }),
    );

    expect(resolved).toMatchObject({
      actorPrincipalId: principalId,
      authorizingGrant: { id: ownerGrant.id },
      reviewItem: {
        decision: "merge",
        resolvedByPrincipalId: principalId,
        status: "resolved",
        version: 1,
      },
    });
    expect(result).toMatchObject({ decision: "merge", status: "resolved", version: 1 });
  });
});
