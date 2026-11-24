import { GetObjectCommand, S3ServiceException } from "@aws-sdk/client-s3";
import type { AgentEmailAttachmentDisposition } from "@deployments-ai/agent-email";
import {
  key,
  type DynamoDatabaseService,
  type IngressInputArtifactScope,
  type Ulid,
} from "@deployments-ai/db";
import type { ExtractionOutcome, FileTextExtractor } from "@deployments-ai/file-text";
import {
  IngressAttachmentReadError,
  makeIngressAttachments,
  type IngressAttachmentCandidate,
  type IngressAttachmentObjectStore,
  type IngressAttachments,
} from "@deployments-ai/ingress-media";
import { createHash } from "node:crypto";
import type { AgentEmailInboundWorkflowMessageV1 } from "./inbound-consumer.ts";
import { databaseRecord } from "./inbound-receipt-routing.ts";

export interface EmailAttachmentReference {
  readonly attachmentId: Ulid;
  readonly inboxMessageId: Ulid;
}

export type EmailIngressAttachments = IngressAttachments<EmailAttachmentReference>;

export interface EmailAttachmentObjectStore {
  readonly send: (
    command: GetObjectCommand,
    options: { readonly abortSignal: AbortSignal },
  ) => Promise<{
    readonly Body?: { transformToByteArray(): Promise<Uint8Array> } | undefined;
  }>;
}

const DISPOSITION_RANK = {
  attachment: 0,
  inline: 1,
} as const satisfies Record<AgentEmailAttachmentDisposition, number>;

export function emailAttachmentCandidates(
  message: AgentEmailInboundWorkflowMessageV1,
): readonly IngressAttachmentCandidate<EmailAttachmentReference>[] {
  return message.attachments
    .toSorted(
      (left, right) => DISPOSITION_RANK[left.disposition] - DISPOSITION_RANK[right.disposition],
    )
    .map((attachment) => ({
      declared: {
        byteSize: attachment.byteSize,
        contentType: attachment.contentType,
        fileName: attachment.fileName,
      },
      identity: { emailAttachmentId: attachment.id, type: "email-attachment" },
      reference: { attachmentId: attachment.id, inboxMessageId: message.messageId },
    }));
}

export function makeEmailIngressAttachments(dependencies: {
  readonly artifactBucket: string;
  readonly database: DynamoDatabaseService;
  readonly emailBuckets: readonly string[];
  readonly emailObjects: EmailAttachmentObjectStore;
  readonly extractor: FileTextExtractor;
  readonly openArtifactObjects: (
    scope: IngressInputArtifactScope,
  ) => Promise<IngressAttachmentObjectStore>;
}): EmailIngressAttachments {
  const reads = new Map<Ulid, Promise<Uint8Array>>();
  const extractions = new Map<string, Promise<ExtractionOutcome>>();

  async function readAttachment(
    organizationId: Ulid,
    reference: EmailAttachmentReference,
    limits: { readonly maxBytes: number; readonly signal: AbortSignal },
  ) {
    const record = await databaseRecord(dependencies.database, "execution", {
      pk: key("ORG", organizationId, "INBOX-MESSAGE", reference.inboxMessageId),
      sk: key("INBOX-ATTACHMENT", reference.attachmentId),
    });
    if (record?.itemType !== "inbox-attachment") {
      throw new IngressAttachmentReadError("permanent", "The email attachment record is gone.");
    }
    const { storage } = record.data;
    if (!dependencies.emailBuckets.includes(storage.bucket)) {
      throw new IngressAttachmentReadError(
        "permanent",
        "The email attachment is outside the email buckets.",
      );
    }
    if (storage.byteSize > limits.maxBytes) {
      throw new IngressAttachmentReadError("permanent", "The email attachment is too large.");
    }
    const object = await dependencies.emailObjects
      .send(
        new GetObjectCommand({
          Bucket: storage.bucket,
          Key: storage.key,
          ...(storage.versionId ? { VersionId: storage.versionId } : {}),
        }),
        { abortSignal: limits.signal },
      )
      .catch((cause: unknown) => {
        // S3 answers a missing object with 403 when the caller cannot list the bucket, as the
        // inbound roles cannot, and with 404 when it can.
        if (
          cause instanceof S3ServiceException &&
          [403, 404].includes(cause.$metadata.httpStatusCode ?? 0)
        ) {
          throw new IngressAttachmentReadError("permanent", "The email attachment object is gone.");
        }
        throw cause;
      });
    const bytes = await object.Body?.transformToByteArray();
    if (!bytes || createHash("sha256").update(bytes).digest("hex") !== record.data.sha256) {
      throw new IngressAttachmentReadError(
        "permanent",
        "The email attachment object does not match its stored digest.",
      );
    }
    return bytes;
  }

  return makeIngressAttachments({
    artifactBucket: dependencies.artifactBucket,
    database: dependencies.database,
    extractor: {
      extract(request, signal) {
        const file = JSON.stringify([
          request.source.sha256,
          request.hint.contentType ?? null,
          request.hint.fileName ?? null,
        ]);
        let extraction = extractions.get(file);
        if (!extraction) {
          extraction = dependencies.extractor.extract(request, signal);
          extractions.set(file, extraction);
        }
        return extraction;
      },
    },
    onTransientFailure: "throw",
    openObjectStore: dependencies.openArtifactObjects,
    openReader:
      async ({ scope }) =>
      async (reference, limits) => {
        let read = reads.get(reference.attachmentId);
        if (!read) {
          read = readAttachment(scope.organizationId, reference, limits);
          reads.set(reference.attachmentId, read);
        }
        return read;
      },
  });
}
