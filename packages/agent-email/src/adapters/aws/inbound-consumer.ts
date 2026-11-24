/* eslint-disable no-await-in-loop -- each inbox owns an independent, ordered persist-then-dispatch boundary. */
import { createHash } from "node:crypto";
import type {
  AgentEmailBlobStore,
  AgentEmailDomainEvent,
  AgentEmailInboxRecord,
  AgentEmailMessageRecord,
  AgentEmailThreadRecord,
  AgentEmailUsageEventRecord,
} from "../../core/index.ts";
import { agentEmailTenantObjectPrefix } from "../../core/index.ts";
import {
  externalizeInboundAgentEmailBodies,
  parseInboundAgentEmail,
  type ExternalizedAgentEmailBodyReference,
  type ParsedInboundAgentEmail,
} from "./message-runtime.ts";

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function deterministicAgentEmailUlid(occurredAt: string, ...identity: readonly string[]) {
  const timestamp = Date.parse(occurredAt);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 0xffff_ffff_ffff) {
    throw new Error("Deterministic agent email ULID timestamp is invalid.");
  }
  const bytes = Buffer.alloc(16);
  bytes.writeUIntBE(timestamp, 0, 6);
  createHash("sha256").update(JSON.stringify(identity)).digest().copy(bytes, 6, 0, 10);
  let value = BigInt(`0x${bytes.toString("hex")}`);
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = `${CROCKFORD_BASE32[Number(value & 31n)]}${encoded}`;
    value >>= 5n;
  }
  return encoded;
}

export interface AgentEmailInboundRawReference {
  readonly bucket: string;
  readonly byteSize: number;
  readonly contentType: "message/rfc822";
  readonly etag?: string;
  readonly key: string;
  readonly sha256: string;
  readonly versionId?: string;
}

export interface AgentEmailInboundRoute {
  readonly environmentId: string;
  readonly inbox: AgentEmailInboxRecord;
  readonly projectId: string;
  readonly rawRetentionDays: number;
}

export interface AgentEmailInboundReservation {
  readonly attachmentIds: readonly string[];
  readonly eventId: string;
  readonly messageId: string;
  readonly threadId: string;
  readonly usageIds: {
    readonly attachmentBytes?: string;
    readonly inboundMessage: string;
    readonly storedBytes: string;
  };
}

export interface AgentEmailInboundAttachmentBlob {
  readonly bucket: string;
  readonly byteSize: number;
  readonly contentId?: string;
  readonly contentType: string;
  readonly disposition: "attachment" | "inline";
  readonly etag?: string;
  readonly fileName: string;
  readonly id: string;
  readonly key: string;
  readonly sha256: string;
  readonly versionId?: string;
}

export interface AgentEmailInboundPersistInput {
  readonly attachments: readonly AgentEmailInboundAttachmentBlob[];
  readonly bodyReferences: {
    readonly htmlBodyRef?: ExternalizedAgentEmailBodyReference;
    readonly rawReference: AgentEmailInboundRawReference;
    readonly textBodyRef?: ExternalizedAgentEmailBodyReference;
  };
  readonly event: AgentEmailDomainEvent;
  readonly message: AgentEmailMessageRecord;
  readonly thread: AgentEmailThreadRecord;
  readonly usage: readonly AgentEmailUsageEventRecord[];
}

export interface AgentEmailInboundConsumerDependencies {
  readonly blobs: AgentEmailBlobStore;
  readonly bucket: string;
  readonly dispatch: (input: {
    readonly bodySummary: string;
    readonly inbox: AgentEmailInboxRecord;
    readonly message: AgentEmailMessageRecord;
    readonly route: AgentEmailInboundRoute;
  }) => Promise<void>;
  readonly isPersisted: (
    message: AgentEmailMessageRecord,
    route: AgentEmailInboundRoute,
  ) => Promise<boolean>;
  readonly persist: (
    input: AgentEmailInboundPersistInput,
    route: AgentEmailInboundRoute,
  ) => Promise<"erased" | "persisted">;
  readonly reserve: (input: {
    readonly attachmentCount: number;
    readonly inboxId: string;
    readonly organizationId: string;
    readonly providerMessageId: string;
    readonly providerRegion: string;
    readonly threadKey: string;
  }) => Promise<AgentEmailInboundReservation>;
  readonly resolveRecipients: (
    recipients: readonly string[],
  ) => Promise<readonly AgentEmailInboundRoute[]>;
}

export interface AgentEmailInboundReceipt {
  readonly completionKey: string;
  readonly objectKey: string;
  readonly providerMessageId: string;
  readonly providerRegion: string;
  readonly raw: Uint8Array;
  readonly rawReference: Omit<AgentEmailInboundRawReference, "byteSize" | "contentType" | "sha256">;
  readonly receivedAt: string;
  readonly recipients: readonly string[];
}

export interface AgentEmailInboundOutcome {
  readonly inboxId: string;
  readonly messageId?: string;
  readonly status: "erased" | "persisted-and-dispatched" | "skipped-inactive";
}

function utf8Prefix(value: string, maximumBytes: number) {
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maximumBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function inboundBodySummary(parsed: ParsedInboundAgentEmail) {
  const candidate =
    parsed.textBody ??
    parsed.htmlBody
      ?.replaceAll(/<(?:br|hr)\s*\/?>/giu, "\n")
      .replaceAll(/<\/(?:div|p|li|tr|h[1-6])\s*>/giu, "\n")
      .replaceAll(/<[^>]+>/gu, " ")
      .replaceAll(/[ \t]+\n/gu, "\n")
      .replaceAll(/\n{3,}/gu, "\n\n")
      .trim() ??
    "";
  return utf8Prefix(candidate, 1024 * 1024);
}

function retentionExpiration(receivedAt: string, retentionDays: number) {
  const received = Date.parse(receivedAt);
  if (!Number.isFinite(received))
    throw new Error("Inbound email receivedAt must be an ISO timestamp.");
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) {
    throw new Error("Inbound email raw retention must be between 1 and 365 days.");
  }
  return new Date(received + retentionDays * 86_400_000).toISOString();
}

function messageParticipants(
  parsed: ParsedInboundAgentEmail,
  inbox: AgentEmailInboxRecord,
): readonly string[] {
  return [
    ...new Set([
      inbox.address,
      parsed.fromAddress,
      ...parsed.toAddresses,
      ...parsed.ccAddresses,
      ...parsed.bccAddresses,
    ]),
  ];
}

function buildReceivedEvent(
  eventId: string,
  inbox: AgentEmailInboxRecord,
  message: AgentEmailMessageRecord & { readonly providerMessageId: string },
): AgentEmailDomainEvent {
  return {
    aggregateId: message.id,
    aggregateType: "agent_email",
    eventId,
    eventType: "agent-email.received",
    payload: {
      address: inbox.address,
      direction: "inbound",
      fromAddress: message.fromAddress,
      inboxId: inbox.id,
      messageId: message.id,
      occurredAt: message.receivedAt ?? message.createdAt,
      organizationId: inbox.organizationId,
      ...(message.providerMessageId ? { providerMessageId: message.providerMessageId } : {}),
      status: "received",
      subject: message.subject,
      toAddresses: message.toAddresses,
      version: 2,
    },
    source: "deployments-ai.agent-email",
  };
}

async function uploadAttachments(
  parsed: ParsedInboundAgentEmail,
  reservation: AgentEmailInboundReservation,
  inbox: AgentEmailInboxRecord,
  route: AgentEmailInboundRoute,
  dependencies: AgentEmailInboundConsumerDependencies,
  createdVersions: {
    readonly bucket: string;
    readonly key: string;
    readonly versionId: string;
  }[],
) {
  if (reservation.attachmentIds.length !== parsed.attachments.length) {
    throw new Error("Inbound email reservation did not allocate every attachment ID.");
  }
  const uploaded: AgentEmailInboundAttachmentBlob[] = [];
  for (const [index, attachment] of parsed.attachments.entries()) {
    const id = reservation.attachmentIds[index];
    if (!id) throw new Error("Inbound email attachment ID is missing.");
    const key = `${agentEmailTenantObjectPrefix({
      environmentId: route.environmentId,
      organizationId: inbox.organizationId,
      projectId: route.projectId,
    })}/attachments/${inbox.id}/${reservation.messageId}/${id}`;
    const stored = await dependencies.blobs.put({
      body: attachment.content,
      contentType: attachment.contentType,
      ifAbsent: true,
      key,
      metadata: { sha256: attachment.sha256 },
    });
    const blob = {
      bucket: dependencies.bucket,
      byteSize: attachment.byteSize,
      ...(attachment.contentId ? { contentId: attachment.contentId } : {}),
      contentType: attachment.contentType,
      disposition: attachment.disposition,
      ...(stored?.etag ? { etag: stored.etag } : {}),
      fileName: attachment.fileName,
      id,
      key,
      sha256: attachment.sha256,
      ...(stored?.versionId ? { versionId: stored.versionId } : {}),
    };
    uploaded.push(blob);
    if (stored?.created === true && stored.versionId) {
      createdVersions.push({
        bucket: dependencies.bucket,
        key,
        versionId: stored.versionId,
      });
    }
  }
  return uploaded;
}

async function throwAfterInboundVersionCleanup(
  dependencies: AgentEmailInboundConsumerDependencies,
  createdVersions: readonly {
    readonly bucket: string;
    readonly key: string;
    readonly versionId: string;
  }[],
  cause: unknown,
): Promise<never> {
  const cleanup = await Promise.allSettled(
    createdVersions.map((reference) =>
      dependencies.blobs.delete(reference.key, reference.bucket, reference.versionId),
    ),
  );
  const cleanupErrors = cleanup.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [cause, ...cleanupErrors],
      "Failed to persist and clean up inbound email content.",
      { cause },
    );
  }
  throw cause;
}

function usageEvents(
  reservation: AgentEmailInboundReservation,
  inbox: AgentEmailInboxRecord,
  message: AgentEmailMessageRecord,
  attachmentBytes: number,
  storedBytes: number,
): readonly AgentEmailUsageEventRecord[] {
  const common = {
    ...(inbox.clientId ? { clientId: inbox.clientId } : {}),
    createdAt: message.createdAt,
    inboxId: inbox.id,
    messageId: message.id,
    organizationId: inbox.organizationId,
  };
  return [
    {
      ...common,
      id: reservation.usageIds.inboundMessage,
      kind: "inbound_message",
      quantity: 1,
    },
    ...(attachmentBytes > 0 && reservation.usageIds.attachmentBytes
      ? [
          {
            ...common,
            id: reservation.usageIds.attachmentBytes,
            kind: "attachment_bytes" as const,
            quantity: attachmentBytes,
          },
        ]
      : []),
    {
      ...common,
      id: reservation.usageIds.storedBytes,
      kind: "stored_bytes",
      quantity: storedBytes,
    },
  ];
}

export async function processAgentEmailInboundReceipt(
  receipt: AgentEmailInboundReceipt,
  dependencies: AgentEmailInboundConsumerDependencies,
): Promise<readonly AgentEmailInboundOutcome[]> {
  if (!receipt.providerMessageId.trim())
    throw new Error("Inbound provider message ID is required.");
  if (!receipt.providerRegion.trim()) throw new Error("Inbound provider region is required.");
  if (!receipt.objectKey.trim() || receipt.objectKey !== receipt.rawReference.key) {
    throw new Error("Inbound raw object reference does not match the receipt.");
  }
  if (!receipt.completionKey.trim() || receipt.completionKey === receipt.objectKey) {
    throw new Error("Inbound receipt completion key is invalid.");
  }
  const rawSha256 = createHash("sha256").update(receipt.raw).digest("hex");
  const parsed = await parseInboundAgentEmail(receipt.raw, receipt.providerMessageId);
  const routes = await dependencies.resolveRecipients(receipt.recipients);
  const outcomes: AgentEmailInboundOutcome[] = [];

  for (const route of routes) {
    const { inbox } = route;
    if (inbox.status !== "active") {
      outcomes.push({ inboxId: inbox.id, status: "skipped-inactive" });
      continue;
    }
    const reservation = await dependencies.reserve({
      attachmentCount: parsed.attachments.length,
      inboxId: inbox.id,
      organizationId: inbox.organizationId,
      providerMessageId: receipt.providerMessageId,
      providerRegion: receipt.providerRegion,
      threadKey: parsed.threadKey,
    });
    const tenantPrefix = agentEmailTenantObjectPrefix({
      environmentId: route.environmentId,
      organizationId: inbox.organizationId,
      projectId: route.projectId,
    });
    const routedRawKey = `raw/${tenantPrefix}/inboxes/${inbox.id}/${reservation.messageId}.eml`;
    const createdVersions: {
      readonly bucket: string;
      readonly key: string;
      readonly versionId: string;
    }[] = [];
    let persistAttempted = false;
    try {
      const routedRaw = await dependencies.blobs.put({
        body: receipt.raw,
        contentType: "message/rfc822",
        ifAbsent: true,
        key: routedRawKey,
        metadata: { sha256: rawSha256 },
      });
      if (routedRaw?.created === true && routedRaw.versionId) {
        createdVersions.push({
          bucket: dependencies.bucket,
          key: routedRawKey,
          versionId: routedRaw.versionId,
        });
      }
      const externalized = await externalizeInboundAgentEmailBodies(parsed, {
        attemptId: `${receipt.providerRegion}:${receipt.providerMessageId}:${inbox.id}`,
        blobs: dependencies.blobs,
        bucket: dependencies.bucket,
        keyPrefix: `${tenantPrefix}/bodies/${inbox.id}/${reservation.messageId}`,
      });
      createdVersions.push(
        ...externalized.createdBodyReferences.flatMap((reference) =>
          reference.versionId
            ? [
                {
                  bucket: reference.bucket,
                  key: reference.key,
                  versionId: reference.versionId,
                },
              ]
            : [],
        ),
      );
      const attachments = await uploadAttachments(
        parsed,
        reservation,
        inbox,
        route,
        dependencies,
        createdVersions,
      );
      const clock = new Date(receipt.receivedAt).toISOString();
      const rawRetentionExpiresAt = retentionExpiration(clock, route.rawRetentionDays);
      const message: AgentEmailMessageRecord & {
        readonly providerMessageId: string;
      } = {
        attachments: attachments.map((attachment) => ({
          byteSize: attachment.byteSize,
          ...(attachment.contentId ? { contentId: attachment.contentId } : {}),
          contentType: attachment.contentType,
          disposition: attachment.disposition,
          fileName: attachment.fileName,
          id: attachment.id,
          messageId: reservation.messageId,
          sha256: attachment.sha256,
        })),
        bccAddresses: externalized.parsed.bccAddresses,
        ccAddresses: externalized.parsed.ccAddresses,
        ...(inbox.clientId ? { clientId: inbox.clientId } : {}),
        createdAt: clock,
        direction: "inbound",
        fromAddress: externalized.parsed.fromAddress,
        ...(externalized.parsed.htmlBody ? { htmlBody: externalized.parsed.htmlBody } : {}),
        id: reservation.messageId,
        ...(externalized.parsed.inReplyTo ? { inReplyTo: externalized.parsed.inReplyTo } : {}),
        inboxId: inbox.id,
        ...(externalized.parsed.internetMessageId
          ? { internetMessageId: externalized.parsed.internetMessageId }
          : {}),
        organizationId: inbox.organizationId,
        providerMessageId: receipt.providerMessageId,
        rawRetentionExpiresAt,
        receivedAt: clock,
        references: externalized.parsed.references,
        replyToAddresses: externalized.parsed.replyToAddresses,
        reprocessCount: 0,
        status: "received",
        subject: externalized.parsed.subject,
        ...(externalized.parsed.textBody !== undefined
          ? { textBody: externalized.parsed.textBody }
          : {}),
        threadId: reservation.threadId,
        threadKey: externalized.parsed.threadKey,
        toAddresses: externalized.parsed.toAddresses,
        updatedAt: clock,
      };
      const thread: AgentEmailThreadRecord = {
        createdAt: clock,
        id: reservation.threadId,
        inboxId: inbox.id,
        lastMessageAt: clock,
        messageCount: 1,
        organizationId: inbox.organizationId,
        participants: messageParticipants(parsed, inbox),
        subject: message.subject,
        updatedAt: clock,
      };
      const attachmentBytes = attachments.reduce((total, value) => total + value.byteSize, 0);
      const bodyBytes = Object.values(externalized.bodyReferences).reduce(
        (total, reference) => total + reference.byteSize,
        0,
      );
      const storedBytes = receipt.raw.byteLength + attachmentBytes + bodyBytes;
      persistAttempted = true;
      let persisted: "erased" | "persisted" = "persisted";
      try {
        persisted = await dependencies.persist(
          {
            attachments,
            bodyReferences: {
              ...externalized.bodyReferences,
              rawReference: {
                bucket: receipt.rawReference.bucket,
                byteSize: receipt.raw.byteLength,
                contentType: "message/rfc822",
                ...(routedRaw?.etag ? { etag: routedRaw.etag } : {}),
                key: routedRawKey,
                sha256: rawSha256,
                ...(routedRaw?.versionId ? { versionId: routedRaw.versionId } : {}),
              },
            },
            event: buildReceivedEvent(reservation.eventId, inbox, message),
            message,
            thread,
            usage: usageEvents(reservation, inbox, message, attachmentBytes, storedBytes),
          },
          route,
        );
      } catch (cause) {
        let reconciled: boolean;
        try {
          reconciled = await dependencies.isPersisted(message, route);
        } catch (reconciliationCause) {
          throw new AggregateError(
            [cause, reconciliationCause],
            "Failed to persist and reconcile inbound email content.",
            { cause },
          );
        }
        if (!reconciled) {
          await throwAfterInboundVersionCleanup(dependencies, createdVersions, cause);
        }
      }
      if (persisted === "erased") {
        await Promise.all(
          createdVersions.map((reference) =>
            dependencies.blobs.delete(reference.key, reference.bucket, reference.versionId),
          ),
        );
        outcomes.push({ inboxId: inbox.id, messageId: reservation.messageId, status: "erased" });
        continue;
      }
      await dependencies.dispatch({
        bodySummary: inboundBodySummary(parsed),
        inbox,
        message,
        route,
      });
      outcomes.push({
        inboxId: inbox.id,
        messageId: reservation.messageId,
        status: "persisted-and-dispatched",
      });
    } catch (cause) {
      if (!persistAttempted) {
        await throwAfterInboundVersionCleanup(dependencies, createdVersions, cause);
      }
      throw cause;
    }
  }

  await dependencies.blobs.put({
    body: new Uint8Array(),
    contentType: "application/vnd.deployments-ai.agent-email-receipt-completion",
    ifAbsent: true,
    key: receipt.completionKey,
  });
  await dependencies.blobs.delete(
    receipt.rawReference.key,
    receipt.rawReference.bucket,
    receipt.rawReference.versionId,
  );
  return outcomes;
}
