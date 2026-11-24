import { createHash } from "node:crypto";
import type {
  BrainApiRouteName,
  CaptureBrainDocumentRequest,
  CreateBrainSourceRequest,
} from "@deployments-ai/api-contract";
import type { Brain, BrainGrant, BrainOperation, BrainRepository } from "@deployments-ai/brains";
import type { ApiIdentity } from "../api-service-contracts.ts";
import { failure } from "../persistence-failure.ts";
import { requiredParam } from "./invocation-parameters.ts";
import type { BrainApiInvocation, BrainApiServiceDependencies } from "./service-contracts.ts";

type KnowledgeRouteName = Extract<
  BrainApiRouteName,
  "captureBrainDocument" | "createBrainSource" | "getBrainDocument" | "listBrainSources"
>;

export interface BrainKnowledgeServiceContext {
  readonly authorize: (
    brain: Brain,
    operation: BrainOperation,
  ) => Promise<{ readonly brain: Brain; readonly callerGrant: BrainGrant }>;
  readonly generateId: () => Promise<string>;
  readonly now: () => string;
  readonly requiredBrain: () => Promise<Brain>;
}

export function mutationActor(identity: ApiIdentity) {
  if (identity.authentication !== "api-credential") {
    return { kind: "human" as const, principalId: identity.principalId };
  }
  const projectId =
    identity.projectIds !== "*" && identity.projectIds?.length === 1
      ? identity.projectIds[0]
      : undefined;
  const environmentId =
    identity.environmentIds !== "*" && identity.environmentIds?.length === 1
      ? identity.environmentIds[0]
      : undefined;
  if (!identity.apiCredentialId || !projectId || !environmentId) {
    return failure(
      "forbidden",
      "brain_caller_scope_invalid",
      "The service caller scope is incomplete.",
    );
  }
  return {
    apiCredentialId: identity.apiCredentialId,
    environmentId,
    kind: "service" as const,
    projectId,
    serviceAccountId: identity.principalId,
  };
}

function documentLifecycle(kind: CaptureBrainDocumentRequest["kind"]) {
  if (kind === "archive") return "archived" as const;
  if (kind === "tombstone") return "deleted" as const;
  return "active" as const;
}

export function ticketMatchesIdentity(
  ticket: Awaited<ReturnType<BrainApiServiceDependencies["repository"]["getUploadTicket"]>>,
  identity: ApiIdentity,
) {
  if (!ticket) return false;
  return identity.authentication === "api-credential"
    ? ticket.createdByServiceAccountId === identity.principalId &&
        ticket.createdByPrincipalId === undefined
    : ticket.createdByPrincipalId === identity.principalId &&
        ticket.createdByServiceAccountId === undefined;
}

export async function invokeBrainKnowledgeRoute(
  dependencies: BrainApiServiceDependencies,
  routeName: KnowledgeRouteName,
  invocation: BrainApiInvocation,
  context: BrainKnowledgeServiceContext,
) {
  const repository = dependencies.repository;

  switch (routeName) {
    case "listBrainSources": {
      const brain = await context.requiredBrain();
      await context.authorize(brain, "read");
      return repository.listSources(invocation.organizationId, brain.id, {
        ...(invocation.query.cursor ? { cursor: invocation.query.cursor } : {}),
        limit: invocation.query.limit ?? 50,
      });
    }

    case "createBrainSource": {
      const brain = await context.requiredBrain();
      const access = await context.authorize(brain, "admin");
      if (access.callerGrant.permission !== "owner") {
        return failure(
          "forbidden",
          "brain_owner_required",
          "A live Brain owner grant is required.",
        );
      }
      const body = invocation.body as CreateBrainSourceRequest;
      const timestamp = context.now();
      return repository.createSource({
        actor: mutationActor(invocation.identity),
        authorizingGrant: access.callerGrant,
        eventId: await context.generateId(),
        ...(body.kind === "github" ? { initialSyncJobId: await context.generateId() } : {}),
        source: {
          brainId: brain.id,
          createdAt: timestamp,
          createdByPrincipalId: invocation.identity.principalId,
          id: await context.generateId(),
          ...(body.kind === "github"
            ? {
                connectionId: body.connectionId,
                configuration: body.configuration,
                environmentId: body.environmentId,
                projectId: body.projectId,
              }
            : {}),
          kind: body.kind,
          name: body.name,
          organizationId: invocation.organizationId,
          status: "active",
          updatedAt: timestamp,
          updatedByPrincipalId: invocation.identity.principalId,
          version: 0,
        },
      });
    }

    case "captureBrainDocument": {
      const brain = await context.requiredBrain();
      const access = await context.authorize(brain, "write");
      const sourceId = requiredParam(invocation, "sourceId");
      const source = await repository.getSource(invocation.organizationId, brain.id, sourceId);
      if (!source || source.status !== "active") {
        return failure(
          "not-found",
          "brain_source_not_found",
          "The active Brain source does not exist.",
        );
      }
      const body = invocation.body as CaptureBrainDocumentRequest;
      const revisionKey = body.sourceRevision ?? invocation.idempotencyKey;
      if (!revisionKey) {
        return failure(
          "invalid-input",
          "brain_revision_identity_required",
          "A source revision or idempotency key is required.",
        );
      }
      const fingerprint = createHash("sha256")
        .update(JSON.stringify({ body, brainId: brain.id, sourceId }))
        .digest("hex");
      const existingClaim = await repository.findSourceRevisionClaim(
        invocation.organizationId,
        source.id,
        body.externalItemIdentity,
        revisionKey,
      );
      if (existingClaim) {
        if (existingClaim.fingerprint !== fingerprint) {
          return failure(
            "conflict",
            "brain_revision_idempotency_conflict",
            "The source revision was already used for a different evidence envelope.",
          );
        }
        const [document, version] = await Promise.all([
          repository.getDocument(invocation.organizationId, brain.id, existingClaim.documentId),
          repository.getDocumentVersion(
            invocation.organizationId,
            existingClaim.documentId,
            existingClaim.versionId,
          ),
        ]);
        if (!document || !version) {
          return failure(
            "internal",
            "brain_revision_result_missing",
            "The accepted revision result is unavailable.",
          );
        }
        return { document, version };
      }
      const uploadTicket =
        body.kind === "content"
          ? await repository.getUploadTicket(
              invocation.organizationId,
              brain.id,
              body.completedUploadTicketId!,
            )
          : undefined;
      if (
        body.kind === "content" &&
        (!uploadTicket ||
          uploadTicket.status !== "completed" ||
          !uploadTicket.bodyRef ||
          uploadTicket.sourceId !== source.id ||
          uploadTicket.expiresAt <= context.now() ||
          !ticketMatchesIdentity(uploadTicket, invocation.identity) ||
          (body.mediaType !== undefined && body.mediaType !== uploadTicket.mediaType))
      ) {
        return failure(
          "unprocessable",
          "brain_upload_ticket_not_consumable",
          "The completed upload ticket is expired, mismatched, or unavailable.",
        );
      }
      const previous = await repository.findDocumentBySourceIdentity(
        invocation.organizationId,
        brain.id,
        source.id,
        body.externalItemIdentity,
      );
      const sourceOrder = body.sourceOrder ?? (previous?.currentSourceOrder ?? -1) + 1;
      if (previous?.currentSourceOrder === sourceOrder) {
        return failure(
          "conflict",
          "brain_source_order_conflict",
          "An equal source order must be an identical revision replay.",
        );
      }
      let restoredContentVersionId: string | undefined;
      let restoredIndexEvidence:
        | {
            readonly rendition: NonNullable<
              Awaited<ReturnType<BrainRepository["getDocumentRendition"]>>
            >;
            readonly version: NonNullable<
              Awaited<ReturnType<BrainRepository["getDocumentVersion"]>>
            >;
          }
        | undefined;
      if (body.kind === "restore") {
        const restored = previous
          ? await repository.getDocumentVersion(
              invocation.organizationId,
              previous.id,
              body.restoredContentVersionId!,
            )
          : undefined;
        const restoredRendition = restored?.originalRenditionId
          ? await repository.getDocumentRendition(
              invocation.organizationId,
              restored.id,
              restored.originalRenditionId,
            )
          : undefined;
        if (!restored || restored.kind !== "content" || !restoredRendition) {
          return failure(
            "unprocessable",
            "brain_restore_content_missing",
            "A restore marker must reference retained content from the same document.",
          );
        }
        restoredContentVersionId = restored.id;
        restoredIndexEvidence = { rendition: restoredRendition, version: restored };
      }
      const timestamp = context.now();
      const versionId = uploadTicket?.id ?? (await context.generateId());
      const [documentId, revisionClaimId, eventId] = await Promise.all([
        previous ? Promise.resolve(previous.id) : context.generateId(),
        context.generateId(),
        context.generateId(),
      ]);
      const originalRenditionId = uploadTicket?.bodyRef ? await context.generateId() : undefined;
      const advances =
        previous?.currentSourceOrder === undefined || sourceOrder > previous.currentSourceOrder;
      const document = previous
        ? advances
          ? {
              ...previous,
              currentEnvelopeHash: fingerprint,
              ...(body.kind === "content"
                ? { currentContentVersionId: versionId }
                : body.kind === "restore"
                  ? { currentContentVersionId: restoredContentVersionId! }
                  : {}),
              currentSourceOrder: sourceOrder,
              currentVersionId: versionId,
              lifecycle: documentLifecycle(body.kind),
              projectionGeneration: previous.projectionGeneration + 1,
              ...(body.sensitivity ? { sensitivity: body.sensitivity } : {}),
              ...(body.sourceLocator ? { sourceLocator: body.sourceLocator } : {}),
              ...(body.title ? { title: body.title } : {}),
              updatedAt: timestamp,
              version: previous.version + 1,
            }
          : previous
        : {
            brainId: brain.id,
            createdAt: timestamp,
            currentEnvelopeHash: fingerprint,
            ...(body.kind === "content" ? { currentContentVersionId: versionId } : {}),
            currentSourceOrder: sourceOrder,
            currentVersionId: versionId,
            externalItemIdentity: body.externalItemIdentity,
            id: documentId,
            lifecycle: documentLifecycle(body.kind),
            organizationId: invocation.organizationId,
            projectionGeneration: 0,
            reviewStatus: "unreviewed" as const,
            sensitivity: body.sensitivity ?? brain.sensitivity,
            sourceId: source.id,
            ...(body.sourceLocator ? { sourceLocator: body.sourceLocator } : {}),
            ...(body.title ? { title: body.title } : {}),
            updatedAt: timestamp,
            version: 0,
          };
      const captured = await repository.captureDocumentRevision({
        actor: mutationActor(invocation.identity),
        authorizingGrant: access.callerGrant,
        document,
        eventId,
        ...(restoredIndexEvidence ? { indexEvidence: restoredIndexEvidence } : {}),
        ...(previous ? { previous } : {}),
        revisionClaim: {
          brainId: brain.id,
          createdAt: timestamp,
          documentId,
          externalItemIdentity: body.externalItemIdentity,
          fingerprint,
          id: revisionClaimId,
          organizationId: invocation.organizationId,
          revisionKey,
          sourceId: source.id,
          versionId,
        },
        ...(uploadTicket?.bodyRef
          ? {
              rendition: {
                bodyRef: uploadTicket.bodyRef,
                brainId: brain.id,
                contentHash: uploadTicket.bodyRef.sha256,
                coordinateSystem: "utf8-byte" as const,
                createdAt: timestamp,
                documentId,
                documentVersionId: versionId,
                id: originalRenditionId!,
                kind: "original" as const,
                organizationId: invocation.organizationId,
              },
            }
          : {}),
        source,
        ...(uploadTicket
          ? {
              uploadTicket: {
                next: {
                  ...uploadTicket,
                  consumedAt: timestamp,
                  documentId,
                  documentVersionId: versionId,
                  revisionClaimId,
                  status: "consumed" as const,
                  updatedAt: timestamp,
                  version: uploadTicket.version + 1,
                },
                previous: uploadTicket,
              },
            }
          : {}),
        version: {
          ...(uploadTicket?.bodyRef
            ? {
                bodyRef: uploadTicket.bodyRef,
                byteSize: uploadTicket.bodyRef.byteSize,
                contentHash: uploadTicket.bodyRef.sha256,
                mediaType: uploadTicket.mediaType,
              }
            : {}),
          brainId: brain.id,
          createdAt: timestamp,
          documentId,
          envelopeHash: fingerprint,
          id: versionId,
          kind: body.kind,
          organizationId: invocation.organizationId,
          ...(originalRenditionId ? { originalRenditionId } : {}),
          ...(previous?.currentVersionId
            ? { predecessorVersionId: previous.currentVersionId }
            : {}),
          ...(restoredContentVersionId ? { restoredContentVersionId } : {}),
          sourceId: source.id,
          sourceOrder,
          ...(body.sourceRevision ? { sourceRevision: body.sourceRevision } : {}),
          ...(body.sourceTimestamp ? { sourceTimestamp: body.sourceTimestamp } : {}),
          ...(body.transitionReason ? { transitionReason: body.transitionReason } : {}),
        },
      });
      return { document: captured.document, version: captured.version };
    }

    case "getBrainDocument": {
      const brain = await context.requiredBrain();
      await context.authorize(brain, "read");
      const document = await repository.getDocument(
        invocation.organizationId,
        brain.id,
        requiredParam(invocation, "documentId"),
      );
      if (!document?.currentVersionId) {
        return failure(
          "not-found",
          "brain_document_not_found",
          "The Brain document does not exist.",
        );
      }
      const version = await repository.getDocumentVersion(
        invocation.organizationId,
        document.id,
        document.currentVersionId,
      );
      if (!version) {
        return failure(
          "internal",
          "brain_document_version_missing",
          "The current Brain document version is unavailable.",
        );
      }
      return { document, version };
    }
  }
}
