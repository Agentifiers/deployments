import type { AgentEmailBlobStore, AgentEmailDomainEvent } from "@deployments-ai/agent-email";
import { buildAgentEmailDomainEvent } from "@deployments-ai/agent-email";
import { createHash } from "node:crypto";
import type { AgentEmailRepositoryContext } from "./persistence-context.ts";
import type { AgentEmailMessageBodyReferences } from "./record-mapping.ts";
import { withCanonicalRecordKeys, type PlatformRecord } from "../records/index.ts";

function blobReferenceFingerprint(reference: AgentEmailMessageBodyReferences["rawReference"]) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        bucket: reference?.bucket,
        byteSize: reference?.byteSize,
        contentType: reference?.contentType,
        etag: reference?.etag,
        key: reference?.key,
        sha256: reference?.sha256,
        versionId: reference?.versionId,
      }),
    )
    .digest("hex");
}

export function makeAgentEmailRetentionRepository(context: AgentEmailRepositoryContext) {
  const {
    database,
    failure,
    getMessage,
    inScope,
    only,
    queryExpiredRawMessages,
    run,
    scope,
    updateVersion,
    updateWithEvent,
  } = context;

  return {
    async listExpiredRawMessages(expiresAt: string, limit = 100) {
      const maximum = Math.max(1, limit);
      const messages: Extract<PlatformRecord, { readonly itemType: "inbox-message" }>[] = [];
      let exclusiveStartKey: Record<string, unknown> | undefined;
      do {
        const page = await run(
          "list-expired-raw-messages",
          queryExpiredRawMessages(
            database,
            scope,
            expiresAt,
            maximum - messages.length,
            exclusiveStartKey,
          ),
        );
        for (const record of only(page.items, "inbox-message")) {
          if (
            inScope(record) &&
            record.data.rawReference !== undefined &&
            record.data.rawPurgedAt === undefined &&
            record.data.rawRetentionExpiresAt !== undefined &&
            record.data.rawRetentionExpiresAt <= expiresAt
          ) {
            messages.push(record);
            if (messages.length >= maximum) break;
          }
        }
        exclusiveStartKey = page.lastEvaluatedKey;
      } while (exclusiveStartKey && messages.length < maximum);
      return messages;
    },

    async claimRawPurge(
      previous: Extract<PlatformRecord, { readonly itemType: "inbox-message" }>,
      claimedAt: string,
    ) {
      if (!inScope(previous)) {
        throw failure("claim-raw-purge", new Error("Message is outside the repository scope."));
      }
      const current = await getMessage(previous.data.inboxId, previous.data.id);
      if (
        !current ||
        !current.data.rawReference ||
        current.data.rawPurgedAt ||
        !current.data.rawRetentionExpiresAt ||
        current.data.rawRetentionExpiresAt > claimedAt
      ) {
        return undefined;
      }
      if (
        current.data.rawPurgeClaimedAt &&
        current.data.rawPurgeClaimKey === current.data.rawReference.key
      ) {
        return current;
      }
      const claimKey = current.data.rawReference.key;
      const claimFingerprint = blobReferenceFingerprint(current.data.rawReference);
      const next = updateVersion(
        withCanonicalRecordKeys({
          data: {
            ...current.data,
            rawPurgeClaimedAt: claimedAt,
            rawPurgeClaimFingerprint: claimFingerprint,
            rawPurgeClaimKey: claimKey,
            updatedAt: claimedAt,
          },
          itemType: "inbox-message",
        }) as Extract<PlatformRecord, { readonly itemType: "inbox-message" }>,
        current,
      );
      try {
        await run(
          "claim-raw-purge",
          database.transactWrite([{ kind: "put", previousRecord: current, record: next }]),
        );
      } catch (cause) {
        const latest = await getMessage(current.data.inboxId, current.data.id);
        if (
          latest?.data.rawPurgeClaimedAt &&
          latest.data.rawPurgeClaimFingerprint === claimFingerprint &&
          latest.data.rawPurgeClaimKey === claimKey &&
          latest.data.rawReference?.key === claimKey &&
          blobReferenceFingerprint(latest.data.rawReference) === claimFingerprint
        ) {
          return latest;
        }
        throw cause;
      }
      return next;
    },

    async finalizeRawPurge(
      inboxId: string,
      messageId: string,
      claimedAt: string,
      claimFingerprint: string,
      claimKey: string,
      rawPurgedAt: string,
      event: AgentEmailDomainEvent,
    ) {
      const previous = await getMessage(inboxId, messageId);
      if (previous?.data.rawPurgedAt && !previous.data.rawReference) return previous;
      if (
        !previous ||
        previous.data.rawPurgeClaimedAt !== claimedAt ||
        previous.data.rawPurgeClaimFingerprint !== claimFingerprint ||
        previous.data.rawPurgeClaimKey !== claimKey ||
        previous.data.rawReference?.key !== claimKey ||
        blobReferenceFingerprint(previous.data.rawReference) !== claimFingerprint
      ) {
        return undefined;
      }
      const {
        rawPurgeClaimedAt: _rawPurgeClaimedAt,
        rawPurgeClaimFingerprint: _rawPurgeClaimFingerprint,
        rawPurgeClaimKey: _rawPurgeClaimKey,
        rawReference: _rawReference,
        ...dataWithoutRawState
      } = previous.data;
      const next = updateVersion(
        withCanonicalRecordKeys({
          data: {
            ...dataWithoutRawState,
            rawPurgedAt,
            updatedAt: rawPurgedAt,
          },
          itemType: "inbox-message",
        }) as Extract<PlatformRecord, { readonly itemType: "inbox-message" }>,
        previous,
      );
      try {
        return await updateWithEvent(previous, next, event);
      } catch (cause) {
        const latest = await getMessage(inboxId, messageId);
        if (latest?.data.rawPurgedAt && !latest.data.rawReference) return latest;
        throw cause;
      }
    },
  };
}

export async function purgeExpiredAgentEmailRawObjects(
  repository: Pick<
    ReturnType<typeof makeAgentEmailRetentionRepository>,
    "claimRawPurge" | "finalizeRawPurge" | "listExpiredRawMessages"
  >,
  blobs: AgentEmailBlobStore,
  args: {
    readonly createEventId: () => string;
    readonly limit?: number;
    readonly now?: Date;
  },
) {
  const now = args.now ?? new Date();
  const occurredAt = now.toISOString();
  const messages = await repository.listExpiredRawMessages(occurredAt, args.limit);
  const failures: unknown[] = [];
  let purged = 0;
  for (const message of messages) {
    try {
      // eslint-disable-next-line no-await-in-loop -- Claim ownership before irreversible deletion.
      const claimed = await repository.claimRawPurge(message, occurredAt);
      const rawReference = claimed?.data.rawReference;
      const claimedAt = claimed?.data.rawPurgeClaimedAt;
      const claimFingerprint = claimed?.data.rawPurgeClaimFingerprint;
      const claimKey = claimed?.data.rawPurgeClaimKey;
      if (
        !claimed ||
        !rawReference ||
        !claimedAt ||
        !claimFingerprint ||
        claimKey !== rawReference.key ||
        blobReferenceFingerprint(rawReference) !== claimFingerprint
      ) {
        continue;
      }
      // Inbound persistence copies each SES receipt to a message-scoped routed key before
      // deleting the shared receipt object, so durable raw references are never shared.
      // eslint-disable-next-line no-await-in-loop -- Retention work is intentionally bounded and sequential.
      await blobs.delete(rawReference.key, rawReference.bucket, rawReference.versionId);
      const event = buildAgentEmailDomainEvent({
        aggregateId: claimed.data.id,
        eventId: args.createEventId(),
        eventType: "agent-email.raw-purged",
        payload: {
          context: {
            environmentId: claimed.data.environmentId,
            projectId: claimed.data.projectId,
          },
          occurredAt,
          organizationId: claimed.data.organizationId,
          resourceId: claimed.data.id,
          resourceType: "message",
          status: claimed.data.status,
          version: 1,
        },
      });
      // eslint-disable-next-line no-await-in-loop -- Finalization rereads the latest record carrying the claim.
      const finalized = await repository.finalizeRawPurge(
        claimed.data.inboxId,
        claimed.data.id,
        claimedAt,
        claimFingerprint,
        claimKey,
        occurredAt,
        event,
      );
      if (!finalized) throw new Error(`Raw purge claim for ${claimed.data.id} was lost.`);
      purged += 1;
    } catch (cause) {
      failures.push(cause);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `Failed to purge ${failures.length} raw email objects.`);
  }
  return { purged };
}
