import type {
  BrainApiRouteName,
  CreateBrainUploadTicketRequest,
} from "@deployments-ai/api-contract";
import type {
  BrainGrant,
  BrainMutationCaller,
  BrainRepository,
  BrainSource,
  BrainUploadLease,
  BrainUploadTicket,
} from "@deployments-ai/brains";
import { failure } from "../persistence-failure.ts";
import { requiredParam } from "./invocation-parameters.ts";
import {
  mutationActor,
  ticketMatchesIdentity,
  type BrainKnowledgeServiceContext,
} from "./knowledge-service.ts";
import type { BrainApiInvocation, BrainApiServiceDependencies } from "./service-contracts.ts";
import type {
  BrainContentDirectUpload,
  BrainContentObject,
  BrainContentUploader,
} from "./content-upload.ts";

type UploadRouteName = Extract<
  BrainApiRouteName,
  "completeBrainUpload" | "createBrainUploadTicket" | "getBrainUploadTicket" | "uploadBrainContent"
>;

interface ContentStorage {
  readonly bucket: string;
  readonly kmsKeyArn: string;
  readonly uploader: BrainContentUploader;
}

function contentStorage(dependencies: BrainApiServiceDependencies): ContentStorage | undefined {
  const { contentBucket, contentKmsKeyArn, contentUploader } = dependencies;
  return contentBucket && contentKmsKeyArn && contentUploader
    ? { bucket: contentBucket, kmsKeyArn: contentKmsKeyArn, uploader: contentUploader }
    : undefined;
}

function contentObject(ticket: BrainUploadTicket, storage: ContentStorage): BrainContentObject {
  return {
    brainId: ticket.brainId,
    bucket: storage.bucket,
    contentLength: ticket.expectedByteSize,
    contentType: ticket.mediaType,
    expectedContentHash: ticket.expectedContentHash,
    kmsKeyArn: storage.kmsKeyArn,
    objectKey: ticket.objectKey,
    organizationId: ticket.organizationId,
    sourceId: ticket.sourceId,
    ticketId: ticket.id,
  };
}

interface OpenUploadLinks {
  readonly directUpload?: BrainContentDirectUpload & {
    readonly completePath: string;
    readonly expiresAt: string;
    readonly method: "PUT";
  };
  readonly uploadPath: string;
}

/**
 * An issued ticket accepts its bytes two ways: a content PUT through the API, which Lambda's 6 MB
 * request payload caps at about 4.5 MiB once API Gateway base64-encodes the body, or a presigned
 * storage PUT followed by a completion call, which carries the full 8 MiB.
 */
async function openUploadLinks(
  ticket: BrainUploadTicket,
  storage: ContentStorage | undefined,
  now: string,
): Promise<OpenUploadLinks | undefined> {
  if (ticket.status !== "issued") return undefined;
  const ticketPath = `/v1/brains/${ticket.brainId}/sources/${ticket.sourceId}/uploads/${ticket.id}`;
  const uploadPath = `${ticketPath}/content`;
  if (!storage) return { uploadPath };
  const signed = await storage.uploader.presign(contentObject(ticket, storage), {
    expiresInSeconds: Math.max(
      1,
      Math.floor((Date.parse(ticket.expiresAt) - Date.parse(now)) / 1_000),
    ),
    signedAt: new Date(now),
  });
  return {
    directUpload: {
      ...signed,
      completePath: `${ticketPath}/complete`,
      expiresAt: ticket.expiresAt,
      method: "PUT",
    },
    uploadPath,
  };
}

function uploadTicketResponse(ticket: BrainUploadTicket, links?: OpenUploadLinks) {
  return {
    ...(ticket.bodyRef ? { bodyRef: ticket.bodyRef } : {}),
    brainId: ticket.brainId,
    ...(ticket.completedAt ? { completedAt: ticket.completedAt } : {}),
    ...(ticket.consumedAt ? { consumedAt: ticket.consumedAt } : {}),
    createdAt: ticket.createdAt,
    ...(links?.directUpload ? { directUpload: links.directUpload } : {}),
    ...(ticket.documentId ? { documentId: ticket.documentId } : {}),
    ...(ticket.documentVersionId ? { documentVersionId: ticket.documentVersionId } : {}),
    expectedByteSize: ticket.expectedByteSize,
    expectedContentHash: ticket.expectedContentHash,
    expiresAt: ticket.expiresAt,
    id: ticket.id,
    mediaType: ticket.mediaType,
    organizationId: ticket.organizationId,
    ...(ticket.revisionClaimId ? { revisionClaimId: ticket.revisionClaimId } : {}),
    sourceId: ticket.sourceId,
    status: ticket.status,
    updatedAt: ticket.updatedAt,
    ...(links ? { uploadPath: links.uploadPath } : {}),
    version: ticket.version,
  };
}

const RESUMABLE_TICKET_STATUSES: ReadonlySet<BrainUploadTicket["status"]> = new Set([
  "completed",
  "consumed",
  "issued",
  "streaming",
]);

/**
 * Starts streaming an issued ticket, or resumes the stream a cancelled completion left behind.
 * The lease shares the ticket's id, so a resend finds the lease the first attempt created.
 */
async function claimUpload(input: {
  readonly actor: BrainMutationCaller;
  readonly authorizingGrant: BrainGrant;
  readonly owner: string;
  readonly repository: BrainRepository;
  readonly source: BrainSource;
  readonly ticket: BrainUploadTicket;
  readonly timestamp: string;
}): Promise<
  { readonly lease: BrainUploadLease; readonly streaming: BrainUploadTicket } | undefined
> {
  const { ticket } = input;
  if (ticket.status === "streaming") {
    const lease = await input.repository.getUploadLease(
      ticket.organizationId,
      ticket.brainId,
      ticket.id,
    );
    return lease?.status === "active" && lease.ticketId === ticket.id
      ? { lease, streaming: ticket }
      : undefined;
  }
  const lease: BrainUploadLease = {
    brainId: ticket.brainId,
    createdAt: input.timestamp,
    expiresAt: ticket.expiresAt,
    id: ticket.id,
    organizationId: ticket.organizationId,
    owner: input.owner,
    status: "active",
    ticketId: ticket.id,
    updatedAt: input.timestamp,
    version: 0,
  };
  const streaming = await input.repository.beginUpload({
    actor: input.actor,
    authorizingGrant: input.authorizingGrant,
    lease,
    next: {
      ...ticket,
      status: "streaming",
      updatedAt: input.timestamp,
      version: ticket.version + 1,
    },
    previous: ticket,
    source: input.source,
  });
  return { lease, streaming };
}

export async function invokeBrainUploadRoute(
  dependencies: BrainApiServiceDependencies,
  routeName: UploadRouteName,
  invocation: BrainApiInvocation,
  context: BrainKnowledgeServiceContext,
) {
  const repository = dependencies.repository;

  switch (routeName) {
    case "createBrainUploadTicket": {
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
      const body = invocation.body as CreateBrainUploadTicketRequest;
      const actor = mutationActor(invocation.identity);
      const timestamp = context.now();
      const ticketId = await context.generateId();
      const expiresAt = new Date(Date.parse(timestamp) + 5 * 60 * 1_000).toISOString();
      const ticket = await repository.issueUploadTicket({
        actor,
        authorizingGrant: access.callerGrant,
        eventId: await context.generateId(),
        source,
        ticket: {
          brainId: brain.id,
          createdAt: timestamp,
          ...(actor.kind === "human"
            ? { createdByPrincipalId: actor.principalId }
            : {
                createdByServiceAccountId: actor.serviceAccountId,
                environmentId: actor.environmentId,
                projectId: actor.projectId,
              }),
          expectedByteSize: body.expectedByteSize,
          expectedContentHash: body.expectedContentHash,
          expiresAt,
          id: ticketId,
          mediaType: body.mediaType,
          objectKey: `organizations/${invocation.organizationId}/brains/${brain.id}/document-versions/${ticketId}/original`,
          organizationId: invocation.organizationId,
          sourceId: source.id,
          status: "issued",
          updatedAt: timestamp,
          version: 0,
        },
      });
      return uploadTicketResponse(
        ticket,
        await openUploadLinks(ticket, contentStorage(dependencies), timestamp),
      );
    }

    case "getBrainUploadTicket": {
      const brain = await context.requiredBrain();
      await context.authorize(brain, "write");
      const sourceId = requiredParam(invocation, "sourceId");
      const ticket = await repository.getUploadTicket(
        invocation.organizationId,
        brain.id,
        requiredParam(invocation, "ticketId"),
      );
      if (
        !ticket ||
        ticket.sourceId !== sourceId ||
        !ticketMatchesIdentity(ticket, invocation.identity)
      ) {
        return failure(
          "not-found",
          "brain_upload_ticket_not_found",
          "The Brain upload ticket does not exist.",
        );
      }
      return uploadTicketResponse(
        ticket,
        await openUploadLinks(ticket, contentStorage(dependencies), context.now()),
      );
    }

    case "completeBrainUpload":
    case "uploadBrainContent": {
      const brain = await context.requiredBrain();
      const access = await context.authorize(brain, "write");
      const sourceId = requiredParam(invocation, "sourceId");
      const ticketId = requiredParam(invocation, "ticketId");
      const requestBody = invocation.rawRequest?.body;
      const storage = contentStorage(dependencies);
      if (!storage || (routeName === "uploadBrainContent" && !requestBody)) {
        return failure(
          "internal",
          "brain_upload_stream_unavailable",
          "The authenticated Brain upload stream is not configured.",
        );
      }
      const [source, ticket] = await Promise.all([
        repository.getSource(invocation.organizationId, brain.id, sourceId),
        repository.getUploadTicket(invocation.organizationId, brain.id, ticketId),
      ]);
      const timestamp = context.now();
      if (
        !source ||
        source.status !== "active" ||
        !ticket ||
        ticket.sourceId !== source.id ||
        !ticketMatchesIdentity(ticket, invocation.identity) ||
        !RESUMABLE_TICKET_STATUSES.has(ticket.status) ||
        ((ticket.status === "issued" || ticket.status === "streaming") &&
          ticket.expiresAt <= timestamp)
      ) {
        return failure(
          "not-found",
          "brain_upload_ticket_not_found",
          "The active Brain upload ticket does not exist.",
        );
      }
      if (routeName === "uploadBrainContent") {
        const headers = invocation.rawRequest!.headers;
        const contentLength = Number(headers.get("content-length"));
        if (
          !Number.isSafeInteger(contentLength) ||
          contentLength !== ticket.expectedByteSize ||
          headers.get("content-type")?.trim() !== ticket.mediaType
        ) {
          return failure(
            "unprocessable",
            "brain_upload_envelope_mismatch",
            "Content-Length and Content-Type must exactly match the issued upload ticket.",
          );
        }
      }
      if (ticket.status === "completed" || ticket.status === "consumed") {
        return uploadTicketResponse(ticket);
      }
      const object = contentObject(ticket, storage);
      const stored =
        routeName === "completeBrainUpload" ? await storage.uploader.verify(object) : undefined;
      if (routeName === "completeBrainUpload" && !stored) {
        return failure(
          "conflict",
          "brain_upload_content_missing",
          "Storage does not hold the exact content the upload ticket names.",
        );
      }
      const actor = mutationActor(invocation.identity);
      const claim = await claimUpload({
        actor,
        authorizingGrant: access.callerGrant,
        owner: await context.generateId(),
        repository,
        source,
        ticket,
        timestamp,
      });
      if (!claim) {
        return failure(
          "not-found",
          "brain_upload_ticket_not_found",
          "The active Brain upload ticket does not exist.",
        );
      }
      const bodyRef = stored ?? (await storage.uploader.upload({ ...object, body: requestBody! }));
      const completedAt = context.now();
      return uploadTicketResponse(
        await repository.completeUpload({
          actor,
          authorizingGrant: access.callerGrant,
          lease: {
            ...claim.lease,
            status: "completed",
            updatedAt: completedAt,
            version: claim.lease.version + 1,
          },
          next: {
            ...claim.streaming,
            bodyRef,
            completedAt,
            status: "completed",
            updatedAt: completedAt,
            version: claim.streaming.version + 1,
          },
          previous: claim.streaming,
          previousLease: claim.lease,
          source,
        }),
      );
    }
  }
}
