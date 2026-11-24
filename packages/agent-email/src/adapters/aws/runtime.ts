import { createHash } from "node:crypto";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  type AgentEmailAttachmentRecord,
  type AgentEmailBlobStore,
  type AgentEmailMessageStatus,
  type AgentEmailOutboundTransport,
  type AgentEmailSendQueueMessage,
} from "../../core/index.ts";

export interface AgentEmailAwsRuntimeConfig {
  readonly bucket: string;
  readonly configurationSetName: string;
  readonly endpointId?: string;
  readonly eventsQueueUrl: string;
  readonly legacyBuckets?: readonly string[];
  readonly loadAttachment?: (attachment: AgentEmailAttachmentRecord) => Promise<Uint8Array>;
  readonly region: string;
  readonly sendQueueUrl: string;
  readonly storageRegion?: string;
  readonly tenantName?: string;
}

export type {
  ExternalizedAgentEmailBodyReference,
  ParsedInboundAgentEmail,
} from "./message-runtime.ts";

export interface AgentEmailQueueRecord {
  readonly body: string;
  readonly messageId: string;
}

export interface AgentEmailQueueEvent {
  readonly Records: readonly AgentEmailQueueRecord[];
}

export interface NormalizedAgentEmailProviderEvent {
  readonly eventType: string;
  readonly internetMessageId?: string;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly providerEventId: string;
  readonly providerMessageId?: string;
  readonly taggedMessageId?: string;
}

function object(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function unwrapAgentEmailNotification(body: string): unknown {
  const parsed = JSON.parse(body) as unknown;
  const envelope = object(parsed);
  const message = string(envelope?.Message);
  if (!message) return parsed;
  try {
    return JSON.parse(message) as unknown;
  } catch {
    return message;
  }
}

const SES_EVENT_DESTINATION_VALIDATION_NOTICE =
  "Successfully validated SNS topic for Amazon SES event publishing.";

/**
 * SES publishes this plain-text notice once when a configuration set's SNS event destination is
 * created. It carries no sending event and is delivered raw or inside an SNS envelope.
 */
export function isSesEventDestinationValidationNotice(body: string) {
  if (body.trim() === SES_EVENT_DESTINATION_VALIDATION_NOTICE) return true;
  try {
    return string(object(JSON.parse(body))?.Message) === SES_EVENT_DESTINATION_VALIDATION_NOTICE;
  } catch {
    return false;
  }
}

function eventDetails(payload: Readonly<Record<string, unknown>>, eventType: string) {
  const key =
    eventType === "BOUNCE"
      ? "bounce"
      : eventType === "COMPLAINT"
        ? "complaint"
        : eventType === "DELIVERY"
          ? "delivery"
          : eventType === "REJECT"
            ? "reject"
            : eventType === "RENDERINGFAILURE"
              ? "failure"
              : eventType === "DELIVERYDELAY"
                ? "deliveryDelay"
                : eventType === "SEND"
                  ? "send"
                  : undefined;
  return key ? object(payload[key]) : undefined;
}

export function parseAgentEmailProviderEvent(
  record: AgentEmailQueueRecord,
): NormalizedAgentEmailProviderEvent {
  const payload = object(unwrapAgentEmailNotification(record.body));
  const mail = object(payload?.mail);
  if (!payload || !mail) throw new Error("SQS record is not an SES sending event.");
  const eventType = (string(payload.eventType ?? payload.notificationType) ?? "")
    .replaceAll(/[^A-Za-z]/gu, "")
    .toUpperCase();
  if (!eventType) throw new Error("SES sending event is missing eventType.");
  const details = eventDetails(payload, eventType);
  const commonHeaders = object(mail.commonHeaders);
  const tags = object(mail.tags);
  const tagged = tags?.agentEmailMessageId;
  const taggedMessageId = Array.isArray(tagged) ? string(tagged[0]) : string(tagged);
  const internetMessageId = string(commonHeaders?.messageId);
  const providerMessageId = string(mail.messageId);
  const occurredAtValue = string(details?.timestamp ?? mail.timestamp);
  const occurredAt =
    occurredAtValue && Number.isFinite(Date.parse(occurredAtValue))
      ? new Date(occurredAtValue).toISOString()
      : new Date().toISOString();
  return {
    eventType,
    ...(internetMessageId ? { internetMessageId } : {}),
    occurredAt,
    payload,
    providerEventId: createHash("sha256").update(record.body).digest("hex"),
    ...(providerMessageId ? { providerMessageId } : {}),
    ...(taggedMessageId ? { taggedMessageId } : {}),
  };
}

export function agentEmailTransitionForProviderEvent(
  eventType: string,
  currentStatus: AgentEmailMessageStatus,
) {
  const allowed = (nextStatus: AgentEmailMessageStatus) => {
    if (nextStatus === "accepted") {
      return ["scheduled", "queued", "sending"].includes(currentStatus);
    }
    if (nextStatus === "delivered") {
      return ["scheduled", "queued", "sending", "accepted"].includes(currentStatus);
    }
    if (nextStatus === "bounced") {
      return currentStatus !== "bounced" && currentStatus !== "complained";
    }
    if (nextStatus === "complained") return currentStatus !== "complained";
    if (nextStatus === "failed") {
      return ["scheduled", "queued", "sending", "accepted"].includes(currentStatus);
    }
    return false;
  };
  if (eventType === "SEND")
    return allowed("accepted")
      ? { eventType: "agent-email.accepted" as const, status: "accepted" as const }
      : undefined;
  if (eventType === "DELIVERY")
    return allowed("delivered")
      ? { eventType: "agent-email.delivered" as const, status: "delivered" as const }
      : undefined;
  if (eventType === "BOUNCE")
    return allowed("bounced")
      ? { eventType: "agent-email.bounced" as const, status: "bounced" as const }
      : undefined;
  if (eventType === "COMPLAINT")
    return allowed("complained")
      ? { eventType: "agent-email.complained" as const, status: "complained" as const }
      : undefined;
  if (eventType === "REJECT" || eventType === "RENDERINGFAILURE") {
    return allowed("failed")
      ? { eventType: "agent-email.failed" as const, status: "failed" as const }
      : undefined;
  }
  return undefined;
}

export class AgentEmailRejectedReceiptError extends Error {
  readonly bucket?: string;
  readonly objectKey: string;
  readonly verdict: "spamVerdict" | "virusVerdict";

  constructor(
    objectKey: string,
    verdict: "spamVerdict" | "virusVerdict",
    status: string | undefined,
    bucket?: string,
  ) {
    super(
      `SES inbound ${verdict} must be PASS before MIME processing (received ${status ?? "none"}).`,
    );
    this.name = "AgentEmailRejectedReceiptError";
    if (bucket) this.bucket = bucket;
    this.objectKey = objectKey;
    this.verdict = verdict;
  }
}

function sesReceiptVerdict(
  receipt: Readonly<Record<string, unknown>>,
  name: "spamVerdict" | "virusVerdict",
  objectKey: string,
  bucket?: string,
) {
  const status = string(object(receipt[name])?.status)?.toUpperCase();
  if (status !== "PASS") {
    throw new AgentEmailRejectedReceiptError(objectKey, name, status, bucket);
  }
  return status;
}

function optionalSesReceiptVerdict(
  receipt: Readonly<Record<string, unknown>>,
  name: "dkimVerdict" | "dmarcVerdict" | "spfVerdict",
) {
  return string(object(receipt[name])?.status)?.toUpperCase();
}

export function parseSesReceiptObjectKey(record: AgentEmailQueueRecord) {
  const notification = object(unwrapAgentEmailNotification(record.body));
  const mail = object(notification?.mail);
  const receipt = object(notification?.receipt);
  const action = object(receipt?.action);
  if (!mail || !receipt || !action)
    throw new Error("SQS record is not an SES receipt notification.");
  const messageId = string(mail.messageId);
  const objectKey = string(action.objectKey);
  const bucket = string(action.bucketName);
  const receivedAt = string(mail.timestamp);
  const recipients = Array.isArray(receipt.recipients)
    ? receipt.recipients.flatMap((value) => (string(value) ? [string(value) as string] : []))
    : [];
  if (!messageId || !objectKey || !receivedAt || !Number.isFinite(Date.parse(receivedAt))) {
    throw new Error("SES receipt notification is missing its object key or timestamp.");
  }
  return {
    messageId,
    objectKey,
    ...(bucket ? { bucket } : {}),
    receivedAt: new Date(receivedAt).toISOString(),
    recipients,
    verdicts: {
      spam: sesReceiptVerdict(receipt, "spamVerdict", objectKey, bucket),
      virus: sesReceiptVerdict(receipt, "virusVerdict", objectKey, bucket),
      ...(optionalSesReceiptVerdict(receipt, "dkimVerdict")
        ? { dkim: optionalSesReceiptVerdict(receipt, "dkimVerdict") }
        : {}),
      ...(optionalSesReceiptVerdict(receipt, "dmarcVerdict")
        ? { dmarc: optionalSesReceiptVerdict(receipt, "dmarcVerdict") }
        : {}),
      ...(optionalSesReceiptVerdict(receipt, "spfVerdict")
        ? { spf: optionalSesReceiptVerdict(receipt, "spfVerdict") }
        : {}),
    },
  };
}

export {
  agentEmailInboundThreadKey,
  agentEmailTenantNameForRegions,
  boundedInboundMailboxes,
  boundedInboundReferences,
  externalizeInboundAgentEmailBodies,
  normalizeSesReferences,
  normalizeSesThreadHeader,
  parseInboundAgentEmail,
  prepareAgentEmailSend,
} from "./message-runtime.ts";
import { prepareAgentEmailSend } from "./message-runtime.ts";

export function makeAgentEmailAwsRuntime(
  config: AgentEmailAwsRuntimeConfig,
  clients: {
    readonly s3?: S3Client;
    readonly ses?: SESv2Client;
    readonly sqs?: SQSClient;
  } = {},
) {
  const s3 = clients.s3 ?? new S3Client({ region: config.storageRegion ?? config.region });
  const ses = clients.ses ?? new SESv2Client({ region: config.region });
  const sqs = clients.sqs ?? new SQSClient({ region: config.region });
  const objectBucket = (targetBucket?: string) => {
    const bucket = targetBucket ?? config.bucket;
    if (bucket !== config.bucket && !config.legacyBuckets?.includes(bucket)) {
      throw new Error("Agent email object points outside the approved storage buckets.");
    }
    return bucket;
  };

  const blobs: AgentEmailBlobStore = {
    delete: async (key, targetBucket, targetVersionId) => {
      const bucket = objectBucket(targetBucket);
      if (targetVersionId) {
        const deletion = await s3.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: [{ Key: key, VersionId: targetVersionId }], Quiet: true },
          }),
        );
        if (deletion.Errors && deletion.Errors.length > 0) {
          throw new Error("S3 failed to delete the uploaded agent email object version.");
        }
        return;
      }
      let keyMarker: string | undefined;
      let versionIdMarker: string | undefined;
      do {
        const versions = await s3.send(
          new ListObjectVersionsCommand({
            Bucket: bucket,
            ...(keyMarker ? { KeyMarker: keyMarker } : {}),
            Prefix: key,
            ...(versionIdMarker ? { VersionIdMarker: versionIdMarker } : {}),
          }),
        );
        const objects = [...(versions.Versions ?? []), ...(versions.DeleteMarkers ?? [])].flatMap(
          (version) =>
            version.Key === key && version.VersionId
              ? [{ Key: key, VersionId: version.VersionId }]
              : [],
        );
        if (objects.length > 0) {
          const deletion = await s3.send(
            new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: { Objects: objects, Quiet: true },
            }),
          );
          if (deletion.Errors && deletion.Errors.length > 0) {
            throw new Error(
              `S3 failed to delete ${deletion.Errors.length} versioned agent email objects.`,
            );
          }
        }
        keyMarker = versions.IsTruncated ? versions.NextKeyMarker : undefined;
        versionIdMarker = versions.IsTruncated ? versions.NextVersionIdMarker : undefined;
      } while (keyMarker || versionIdMarker);
    },
    get: async (key, versionId, targetBucket) => {
      const result = await s3.send(
        new GetObjectCommand({
          Bucket: objectBucket(targetBucket),
          Key: key,
          ...(versionId ? { VersionId: versionId } : {}),
        }),
      );
      if (!result.Body) throw new Error(`S3 object ${key} has no body.`);
      return result.Body.transformToByteArray();
    },
    put: async ({ body, contentType, ifAbsent, key, metadata }) => {
      let result;
      try {
        result = await s3.send(
          new PutObjectCommand({
            Body: body,
            Bucket: config.bucket,
            ContentType: contentType,
            ...(ifAbsent ? { IfNoneMatch: "*" } : {}),
            Key: key,
            Metadata: metadata,
          }),
        );
      } catch (cause) {
        const responseMetadata =
          cause && typeof cause === "object" && "$metadata" in cause
            ? (cause.$metadata as { readonly httpStatusCode?: number })
            : undefined;
        if (
          !ifAbsent ||
          !(
            (cause instanceof Error && cause.name === "PreconditionFailed") ||
            responseMetadata?.httpStatusCode === 412
          )
        ) {
          throw cause;
        }
        const existing = await s3.send(
          new HeadObjectCommand({
            Bucket: config.bucket,
            Key: key,
          }),
        );
        const storedMetadata = new Map(
          Object.entries(existing.Metadata ?? {}).map(([name, value]) => [
            name.toLowerCase(),
            value,
          ]),
        );
        const metadataMatches = Object.entries(metadata ?? {}).every(
          ([name, value]) => storedMetadata.get(name.toLowerCase()) === value,
        );
        if (
          existing.ContentLength !== body.byteLength ||
          existing.ContentType !== contentType ||
          !metadataMatches ||
          !existing.VersionId
        ) {
          throw new Error(`S3 object ${key} already exists with different content.`, {
            cause,
          });
        }
        return {
          created: false,
          ...(existing.ETag ? { etag: existing.ETag } : {}),
          versionId: existing.VersionId,
        };
      }
      return {
        created: true,
        ...(result.ETag ? { etag: result.ETag } : {}),
        ...(result.VersionId ? { versionId: result.VersionId } : {}),
      };
    },
    signedGetUrl: (key, expiresInSeconds, versionId, targetBucket) =>
      getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket: objectBucket(targetBucket),
          Key: key,
          ...(versionId ? { VersionId: versionId } : {}),
        }),
        { expiresIn: expiresInSeconds },
      ),
  };

  const outbound: AgentEmailOutboundTransport = {
    send: async (message) => {
      if (message.attachments.length > 0 && !config.loadAttachment) {
        throw new Error("Agent email attachment loading is not configured.");
      }
      const attachments = await Promise.all(
        message.attachments.map(async (attachment) => ({
          ...attachment,
          content: await config.loadAttachment!(attachment),
        })),
      );
      const result = await ses.send(
        new SendEmailCommand(
          prepareAgentEmailSend({
            attachments,
            configurationSetName: config.configurationSetName,
            ...(config.endpointId ? { endpointId: config.endpointId } : {}),
            message,
            ...(config.tenantName ? { tenantName: config.tenantName } : {}),
          }),
        ),
      );
      if (!result.MessageId) throw new Error("Amazon SES did not return a message ID.");
      return { providerMessageId: result.MessageId };
    },
  };

  return {
    blobs,
    outbound,
    enqueueProviderEvent: (body: unknown) =>
      sqs.send(
        new SendMessageCommand({
          MessageBody: JSON.stringify(body),
          QueueUrl: config.eventsQueueUrl,
        }),
      ),
    enqueueSend: (message: Omit<AgentEmailSendQueueMessage, "type">) =>
      sqs.send(
        new SendMessageCommand({
          MessageBody: JSON.stringify({ ...message, type: "agent-email-send" }),
          QueueUrl: config.sendQueueUrl,
        }),
      ),
    s3,
    ses,
    sqs,
  };
}
