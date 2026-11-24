import { Schema } from "effect";
import { isDeepStrictEqual } from "node:util";
import type { DynamoDatabaseService } from "../client-types.ts";
import { MAX_THREADLESS_STABLE_TENANT_MUTATIONS_PER_TRANSACTION } from "../governance-tenant-directory.ts";
import type { Ulid } from "../ids.ts";
import {
  ChannelIngressBurstHeadRecord,
  ChannelIngressBurstRecord,
  ChannelIngressSourceRecord,
} from "../records/conversations.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { isDatabaseWriteConflict } from "../transaction-conditions.ts";
import {
  DEFAULT_MAX_ATTACHMENTS,
  DEFAULT_MAX_CONTENT_BYTES,
  DEFAULT_MAX_MESSAGES,
  DEFAULT_MAX_METADATA_BYTES,
  DEFAULT_MAX_PAYLOAD_BYTES,
  DEFAULT_MAX_SINGLETON_METADATA_BYTES,
  DEFAULT_QUIET_PERIOD_MS,
  PREDECESSOR_RETRY_DELAY_MS,
  RETENTION_MS,
  WRITE_ATTEMPTS,
  asRoute,
  assertRetained,
  canonicalNow,
  canonicalTimestamp,
  crossesQuietWindow,
  expiresAt,
  positiveLimit,
  readBurst,
  ready,
  scopeMatches,
  ttl,
  validateFlushScope,
  validateLinkedBurst,
  validateSource,
  validateSourceClaim,
  type BurstHead,
  type BurstRecord,
  type ChannelIngressBurstFlush,
  type ChannelIngressBurstMessageInput,
  type ChannelIngressBurstPersistence,
  type ChannelIngressBurstPersistenceOptions,
  type ChannelIngressBurstPreparation,
  type ChannelIngressBurstStageResult,
} from "./model.ts";
import {
  channelIngressBurstId,
  channelIngressBurstKey,
  channelIngressBurstRouteId,
  channelIngressHeadKey,
  channelIngressSourceClaimKey,
  channelIngressSourceKey,
  channelIngressSourceRecordId,
} from "./keys.ts";
import {
  claimedSourceResult,
  flushForBurst,
  sourceClaim,
  sourceResult,
} from "./source-accounting.ts";

export { channelIngressBurstRouteId, channelIngressSourceRecordId } from "./keys.ts";
export type {
  ChannelIngressBurstFlush,
  ChannelIngressBurstMessageInput,
  ChannelIngressBurstPersistence,
  ChannelIngressBurstPersistenceOptions,
  ChannelIngressBurstPreparation,
  ChannelIngressBurstRoute,
  ChannelIngressBurstStageResult,
} from "./model.ts";

// Rollover atomically writes the sealed burst, each prepared source, the incoming source and its
// permanent claim, and the head. Each tenant mutation receives a governance-directory companion,
// while DB invariants reserve the final two DynamoDB operations. Keep the accepted burst size
// within that expanded transaction.
const MAX_MESSAGES_PER_BURST = MAX_THREADLESS_STABLE_TENANT_MUTATIONS_PER_TRANSACTION - 4;

async function load(
  database: DynamoDatabaseService,
  recordKey: { readonly pk: string; readonly sk: string },
) {
  return await database.getRecord("execution", recordKey, true);
}

function flushFor(head: BurstHead): ChannelIngressBurstFlush | undefined {
  if (!head.data.activeBurstId || !head.data.dueAt) return undefined;
  return {
    bindingId: head.data.route.bindingId as Ulid,
    burstId: head.data.activeBurstId,
    dueAt: head.data.dueAt,
    environmentId: head.data.environmentId,
    organizationId: head.data.organizationId,
    projectId: head.data.projectId,
    routeId: head.data.routeId,
  };
}

function validateHead(head: BurstHead, input: ChannelIngressBurstMessageInput, routeId: string) {
  if (
    !scopeMatches(head, input) ||
    head.data.id !== routeId ||
    head.data.routeId !== routeId ||
    !isDeepStrictEqual(head.data.route, asRoute(input.route))
  ) {
    throw new Error("The inbound burst head does not match its route identity.");
  }
}

export function makeChannelIngressBurstPersistence(
  options: ChannelIngressBurstPersistenceOptions,
): ChannelIngressBurstPersistence {
  const now = options.now ?? (() => new Date());
  const quietPeriodMs = positiveLimit(
    options.quietPeriodMs ?? DEFAULT_QUIET_PERIOD_MS,
    "Channel ingress quiet period",
  );
  const limits = {
    attachments: positiveLimit(
      options.maxAttachments ?? DEFAULT_MAX_ATTACHMENTS,
      "Channel ingress burst attachment limit",
    ),
    contentBytes: positiveLimit(
      options.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES,
      "Channel ingress burst content limit",
    ),
    messages: positiveLimit(
      options.maxMessages ?? DEFAULT_MAX_MESSAGES,
      "Channel ingress burst message limit",
    ),
    metadataBytes: positiveLimit(
      options.maxMetadataBytes ?? DEFAULT_MAX_METADATA_BYTES,
      "Channel ingress burst metadata limit",
    ),
    payloadBytes: positiveLimit(
      options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
      "Channel ingress burst payload limit",
    ),
    singletonMetadataBytes: positiveLimit(
      options.maxSingletonMetadataBytes ?? DEFAULT_MAX_SINGLETON_METADATA_BYTES,
      "Channel ingress singleton metadata limit",
    ),
  };

  if (limits.messages > MAX_MESSAGES_PER_BURST) {
    throw new Error(`Channel ingress burst message limit cannot exceed ${MAX_MESSAGES_PER_BURST}.`);
  }

  function burstTotals(pending: BurstHead["data"]["pending"]) {
    return pending.reduce(
      (totals, candidate, index) => ({
        attachments: totals.attachments + candidate.attachmentCount,
        contentBytes: totals.contentBytes + candidate.contentBytes + (index > 0 ? 1 : 0),
        metadataBytes: totals.metadataBytes + candidate.metadataBytes,
        payloadBytes: totals.payloadBytes + candidate.payloadBytes,
      }),
      { attachments: 0, contentBytes: 0, metadataBytes: 0, payloadBytes: 0 },
    );
  }

  function fitsOneBurst(pending: BurstHead["data"]["pending"]) {
    const totals = burstTotals(pending);
    return (
      pending.length <= limits.messages &&
      totals.attachments <= limits.attachments &&
      totals.contentBytes <= limits.contentBytes &&
      totals.metadataBytes <=
        (pending.length === 1 ? limits.singletonMetadataBytes : limits.metadataBytes) &&
      totals.payloadBytes <= limits.payloadBytes
    );
  }

  async function pendingPredecessorId(head: BurstHead, observedAt: Date) {
    if (!head.data.latestBurstId) return undefined;
    const value = await load(
      options.database,
      channelIngressBurstKey(head.data.organizationId, head.data.routeId, head.data.latestBurstId),
    );
    if (!value) {
      if (Date.parse(head.data.updatedAt) + RETENTION_MS <= observedAt.getTime()) return undefined;
      throw new Error("The latest inbound burst is unavailable before its retention elapsed.");
    }
    const latest = validateLinkedBurst(value, head);
    if (Date.parse(latest.data.expiresAt) <= observedAt.getTime()) return undefined;
    return latest.data.status === "prepared" ? latest.data.id : undefined;
  }

  async function preparedHeadState(
    head: BurstHead,
    observedAt: Date,
    precedingBurstId: string | undefined,
  ) {
    const activeBurstId = head.data.activeBurstId;
    if (!activeBurstId || !head.data.dueAt || head.data.pending.length === 0) {
      throw new Error("The active inbound burst head has no pending source messages.");
    }
    if (!fitsOneBurst(head.data.pending)) {
      throw new Error("The active inbound burst head exceeds its configured bounds.");
    }
    const ordered = [...head.data.pending].toSorted(
      (left, right) =>
        left.sequence - right.sequence || left.sourceRecordId.localeCompare(right.sourceRecordId),
    );
    if (ordered.some((candidate) => candidate.senderId !== ordered[0]!.senderId)) {
      throw new Error("An inbound burst cannot contain messages from different senders.");
    }
    const sources = await Promise.all(
      ordered.map(async (candidate) => {
        const value = await load(
          options.database,
          channelIngressSourceKey(
            head.data.organizationId,
            head.data.routeId,
            candidate.sourceRecordId,
          ),
        );
        if (
          !value ||
          value.itemType !== "channel-ingress-source" ||
          !scopeMatches(value, head.data) ||
          value.data.routeId !== head.data.routeId ||
          value.data.id !== candidate.sourceRecordId ||
          value.data.status !== "staged" ||
          value.data.burstId !== undefined ||
          value.data.receivedAt !== candidate.receivedAt ||
          value.data.senderId !== candidate.senderId ||
          value.data.contentBytes !== candidate.contentBytes
        ) {
          throw new Error("The staged inbound source does not match its burst head.");
        }
        assertRetained(value, observedAt);
        return value;
      }),
    );
    const expiration = expiresAt(observedAt);
    const createdAt = observedAt.toISOString();
    const totals = burstTotals(ordered);
    const burst = Schema.decodeUnknownSync(ChannelIngressBurstRecord)(
      withCanonicalRecordKeys({
        data: {
          attachmentCount: totals.attachments,
          contentBytes: totals.contentBytes,
          createdAt,
          environmentId: head.data.environmentId,
          expiresAt: expiration,
          id: activeBurstId,
          metadataBytes: totals.metadataBytes,
          organizationId: head.data.organizationId,
          payloadBytes: totals.payloadBytes,
          payloads: sources.map((source) => source.data.payload),
          ...(precedingBurstId ? { precedingBurstId } : {}),
          projectId: head.data.projectId,
          routeId: head.data.routeId,
          sourceMessageIds: sources.map((source) => source.data.sourceMessageId),
          sourceRecordIds: sources.map((source) => source.data.id),
          status: "prepared" as const,
          throughSequence: ordered.at(-1)!.sequence,
          updatedAt: createdAt,
          version: 0,
        },
        itemType: "channel-ingress-burst" as const,
        ttl: ttl(expiration),
      }),
    );
    const preparedSources = sources.map((source) =>
      Schema.decodeUnknownSync(ChannelIngressSourceRecord)(
        withCanonicalRecordKeys({
          ...source,
          data: {
            ...source.data,
            burstId: activeBurstId,
            status: "prepared" as const,
            updatedAt: createdAt,
            version: source.data.version + 1,
          },
        }),
      ),
    );
    return { burst, preparedSources, sources };
  }

  async function preparationForBurst(
    record: BurstRecord,
    observedAt: Date,
  ): Promise<ChannelIngressBurstPreparation> {
    assertRetained(record, observedAt);
    if (record.data.status === "submitted") return { kind: "superseded" };
    if (record.data.precedingBurstId) {
      const preceding = validateLinkedBurst(
        await load(
          options.database,
          channelIngressBurstKey(
            record.data.organizationId,
            record.data.routeId,
            record.data.precedingBurstId,
          ),
        ),
        record,
      );
      assertRetained(preceding, observedAt);
      if (preceding.data.status !== "submitted") {
        return {
          dueAt: new Date(observedAt.getTime() + PREDECESSOR_RETRY_DELAY_MS).toISOString(),
          kind: "waiting",
          waitFor: "predecessor",
        };
      }
    }
    return ready(record);
  }

  async function stage(
    input: ChannelIngressBurstMessageInput,
  ): Promise<ChannelIngressBurstStageResult> {
    if (input.route.bindingId !== input.bindingId) {
      throw new Error("Channel ingress burst route binding does not match queue scope.");
    }
    if (!input.senderId.trim()) throw new Error("Channel ingress sender ID is required.");
    const receiptTime = canonicalTimestamp(input.receivedAt, "Channel ingress receipt time");
    const routeId = channelIngressBurstRouteId(input.route);
    const id = channelIngressSourceRecordId(routeId, input.sourceMessageId);
    const claimLocation = channelIngressSourceClaimKey(input.organizationId, routeId, id);
    const sourceLocation = channelIngressSourceKey(input.organizationId, routeId, id);
    const metric = (value: number | undefined, label: string) =>
      value === undefined ? 0 : positiveLimit(value, label);
    const metrics = {
      attachmentCount: input.attachmentCount ?? 0,
      contentBytes: positiveLimit(input.contentBytes, "Channel ingress content bytes"),
      metadataBytes: metric(input.metadataBytes, "Channel ingress metadata bytes"),
      payloadBytes: metric(input.payloadBytes, "Channel ingress payload bytes"),
    };
    if (!Number.isSafeInteger(metrics.attachmentCount) || metrics.attachmentCount < 0) {
      throw new Error("Channel ingress attachment count must be a non-negative safe integer.");
    }

    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
      const claimValue = await load(options.database, claimLocation);
      const existingValue = await load(options.database, sourceLocation);
      if (claimValue) {
        if (claimValue.itemType !== "channel-ingress-source-claim") {
          throw new Error("The inbound source claim key resolved to a different record type.");
        }
        validateSourceClaim(claimValue, input, routeId, id);
        const observedAt = canonicalNow(now);
        if (!existingValue) return claimedSourceResult(claimValue);
        if (existingValue.itemType !== "channel-ingress-source") {
          throw new Error("The inbound source key resolved to a different record type.");
        }
        validateSource(existingValue, input, routeId);
        if (Date.parse(existingValue.data.expiresAt) <= observedAt.getTime()) {
          return claimedSourceResult(claimValue);
        }
        if (existingValue.data.status === "prepared") {
          return sourceResult(existingValue, input, undefined, observedAt);
        }
        const headValue = await load(
          options.database,
          channelIngressHeadKey(input.organizationId, routeId),
        );
        if (!headValue || headValue.itemType !== "channel-ingress-burst-head") continue;
        validateHead(headValue, input, routeId);
        const pending = headValue.data.pending.some((candidate) => candidate.sourceRecordId === id);
        const activeFlush = flushFor(headValue);
        if (!pending || !activeFlush) continue;
        return sourceResult(existingValue, input, activeFlush, observedAt);
      }
      if (existingValue) {
        throw new Error("An inbound source is missing its permanent accounting claim.");
      }

      const acceptedAt = canonicalNow(now);
      const acceptedAtIso = acceptedAt.toISOString();
      // Provider webhooks stamp receivedAt before queueing. Use it for conversational timing so a
      // backlog cannot collapse turns received minutes apart, while clamping future clock skew to
      // the trusted consumer clock.
      const burstAt = new Date(Math.min(receiptTime, acceptedAt.getTime()));
      const burstAtIso = burstAt.toISOString();
      const expiration = expiresAt(acceptedAt);
      const headValue = await load(
        options.database,
        channelIngressHeadKey(input.organizationId, routeId),
      );
      if (headValue && headValue.itemType !== "channel-ingress-burst-head") {
        throw new Error("The inbound burst head key resolved to a different record type.");
      }
      if (headValue) validateHead(headValue, input, routeId);
      // A head deliberately outlives its source TTL so route identity remains stable. Once any
      // pending source reaches logical retention, abandon the whole incomplete burst atomically
      // with the next accepted source instead of leaving the route permanently unrecoverable.
      const activeHead = headValue?.data.pending.some(
        (candidate) => Date.parse(candidate.acceptedAt) + RETENTION_MS <= acceptedAt.getTime(),
      )
        ? undefined
        : headValue;
      const pendingSource = {
        acceptedAt: acceptedAtIso,
        attachmentCount: metrics.attachmentCount,
        contentBytes: metrics.contentBytes,
        metadataBytes: metrics.metadataBytes,
        payloadBytes: metrics.payloadBytes,
        receivedAt: burstAtIso,
        senderId: input.senderId,
        sequence: headValue?.data.nextSequence ?? 0,
        sourceRecordId: id,
      };
      if (!fitsOneBurst([pendingSource])) {
        throw new Error("A channel ingress source exceeds the configured burst bounds.");
      }
      const existingPending = activeHead?.data.pending ?? [];
      const hasActiveBurst = existingPending.length > 0;
      if (
        activeHead &&
        (hasActiveBurst !== Boolean(activeHead.data.activeBurstId) ||
          hasActiveBurst !== Boolean(activeHead.data.dueAt))
      ) {
        throw new Error("The inbound burst head active state is inconsistent.");
      }
      const shouldSeal =
        hasActiveBurst &&
        (crossesQuietWindow([...existingPending, pendingSource], quietPeriodMs) ||
          existingPending.at(-1)!.senderId !== pendingSource.senderId ||
          !fitsOneBurst([...existingPending, pendingSource]));
      const predecessor = activeHead
        ? await pendingPredecessorId(activeHead, acceptedAt)
        : undefined;
      const closing = shouldSeal
        ? await preparedHeadState(activeHead!, acceptedAt, predecessor)
        : undefined;
      const activeBurstId = shouldSeal
        ? channelIngressBurstId(routeId, id, pendingSource.sequence)
        : (activeHead?.data.activeBurstId ??
          channelIngressBurstId(routeId, id, pendingSource.sequence));
      // Receipt time decides whether messages belong to different conversational turns. The
      // independent flush trigger must wait from durable acceptance, though, or a queued/backlogged
      // message would arrive with an already-expired deadline and race the next FIFO source.
      const candidateDueAt = acceptedAt.getTime() + quietPeriodMs;
      const dueAt = new Date(
        !shouldSeal && activeHead?.data.dueAt
          ? Math.max(candidateDueAt, Date.parse(activeHead.data.dueAt))
          : candidateDueAt,
      ).toISOString();
      const source = Schema.decodeUnknownSync(ChannelIngressSourceRecord)(
        withCanonicalRecordKeys({
          data: {
            contentBytes: metrics.contentBytes,
            createdAt: acceptedAtIso,
            environmentId: input.environmentId,
            expiresAt: expiration,
            id,
            organizationId: input.organizationId,
            payload: input.payload,
            ...(closing ? { precedingBurstId: closing.burst.data.id } : {}),
            projectId: input.projectId,
            receivedAt: burstAtIso,
            routeId,
            senderId: input.senderId,
            sourceFingerprint: input.sourceFingerprint,
            sourceMessageId: input.sourceMessageId,
            status: "staged" as const,
            updatedAt: acceptedAtIso,
            version: 0,
          },
          itemType: "channel-ingress-source" as const,
          ttl: ttl(expiration),
        }),
      );
      const claim = sourceClaim(input, {
        burstId: activeBurstId,
        createdAt: acceptedAtIso,
        id,
        routeId,
      });
      const head = Schema.decodeUnknownSync(ChannelIngressBurstHeadRecord)(
        withCanonicalRecordKeys({
          data: {
            activeBurstId,
            createdAt: headValue?.data.createdAt ?? acceptedAtIso,
            dueAt,
            environmentId: input.environmentId,
            id: routeId,
            ...(closing
              ? { latestBurstId: closing.burst.data.id }
              : predecessor
                ? { latestBurstId: predecessor }
                : {}),
            nextSequence: pendingSource.sequence + 1,
            organizationId: input.organizationId,
            pending: shouldSeal ? [pendingSource] : [...existingPending, pendingSource],
            projectId: input.projectId,
            route: asRoute(input.route),
            routeId,
            updatedAt: acceptedAtIso,
            version: (headValue?.data.version ?? -1) + 1,
          },
          itemType: "channel-ingress-burst-head" as const,
        }),
      );
      try {
        const closingOperations = closing
          ? [
              { kind: "put" as const, record: closing.burst },
              ...closing.preparedSources.map((record, index) => ({
                kind: "put" as const,
                previousRecord: closing.sources[index]!,
                record,
              })),
            ]
          : [];
        await options.database.transactWrite([
          ...closingOperations,
          { kind: "put", record: claim },
          {
            kind: "put",
            record: source,
          },
          {
            kind: "put",
            ...(headValue ? { previousRecord: headValue } : {}),
            record: head,
          },
        ]);
        const flush = flushFor(head)!;
        return {
          burstId: activeBurstId,
          duplicate: false,
          flushes: [
            ...(closing
              ? [flushForBurst(input, routeId, closing.burst.data.id, acceptedAtIso)]
              : []),
            flush,
          ],
          routeId,
        };
      } catch (cause) {
        if (!isDatabaseWriteConflict(cause)) throw cause;
      }
    }
    throw new Error("Channel ingress source could not be staged after concurrent writes.");
  }

  async function prepare(flush: ChannelIngressBurstFlush): Promise<ChannelIngressBurstPreparation> {
    canonicalTimestamp(flush.dueAt, "Channel ingress flush due time");
    const storedBurstLocation = channelIngressBurstKey(
      flush.organizationId,
      flush.routeId,
      flush.burstId,
    );
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
      const observedAt = canonicalNow(now);
      const existing = readBurst(await load(options.database, storedBurstLocation), flush);
      if (existing) {
        return preparationForBurst(existing, observedAt);
      }
      const headValue = await load(
        options.database,
        channelIngressHeadKey(flush.organizationId, flush.routeId),
      );
      if (!headValue) return { kind: "superseded" };
      if (headValue.itemType !== "channel-ingress-burst-head") {
        throw new Error("The inbound burst head key resolved to a different record type.");
      }
      validateFlushScope(headValue, flush);
      if (headValue.data.route.bindingId !== flush.bindingId) {
        throw new Error("The inbound burst flush binding does not match its route.");
      }
      if (headValue.data.activeBurstId !== flush.burstId) return { kind: "superseded" };
      if (!headValue.data.dueAt || headValue.data.pending.length === 0)
        throw new Error("The active inbound burst head has no pending source messages.");
      if (observedAt.getTime() < Date.parse(headValue.data.dueAt)) {
        return {
          dueAt: headValue.data.dueAt,
          kind: "waiting",
          waitFor: "quiet-window",
        };
      }
      const predecessor = await pendingPredecessorId(headValue, observedAt);
      const closing = await preparedHeadState(headValue, observedAt, predecessor);
      if (closing.burst.data.id !== flush.burstId) {
        throw new Error("The prepared inbound burst does not match its flush identity.");
      }
      const createdAt = observedAt.toISOString();
      const nextHead = Schema.decodeUnknownSync(ChannelIngressBurstHeadRecord)(
        withCanonicalRecordKeys({
          data: {
            createdAt: headValue.data.createdAt,
            environmentId: headValue.data.environmentId,
            id: headValue.data.id,
            latestBurstId: closing.burst.data.id,
            nextSequence: headValue.data.nextSequence,
            organizationId: headValue.data.organizationId,
            pending: [],
            projectId: headValue.data.projectId,
            route: headValue.data.route,
            routeId: headValue.data.routeId,
            updatedAt: createdAt,
            version: headValue.data.version + 1,
          },
          itemType: "channel-ingress-burst-head" as const,
        }),
      );
      try {
        await options.database.transactWrite([
          { kind: "put", record: closing.burst },
          ...closing.preparedSources.map((record, index) => ({
            kind: "put" as const,
            previousRecord: closing.sources[index]!,
            record,
          })),
          { kind: "put", previousRecord: headValue, record: nextHead },
        ]);
        return preparationForBurst(closing.burst, observedAt);
      } catch (cause) {
        if (!isDatabaseWriteConflict(cause)) throw cause;
      }
    }
    throw new Error("Channel ingress burst could not be prepared after concurrent writes.");
  }

  async function complete(flush: ChannelIngressBurstFlush) {
    canonicalTimestamp(flush.dueAt, "Channel ingress flush due time");
    const location = channelIngressBurstKey(flush.organizationId, flush.routeId, flush.burstId);
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
      const observedAt = canonicalNow(now);
      const current = readBurst(await load(options.database, location), flush);
      if (!current) throw new Error("The submitted inbound burst is unavailable.");
      assertRetained(current, observedAt);
      if (current.data.status === "submitted") return;
      const preparation = await preparationForBurst(current, observedAt);
      if (preparation.kind !== "ready") {
        throw new Error("An inbound burst cannot complete before its predecessor.");
      }
      const submittedAt = observedAt.toISOString();
      const submitted = Schema.decodeUnknownSync(ChannelIngressBurstRecord)(
        withCanonicalRecordKeys({
          ...current,
          data: {
            ...current.data,
            status: "submitted" as const,
            submittedAt,
            updatedAt: submittedAt,
            version: current.data.version + 1,
          },
        }),
      );
      try {
        await options.database.transactWrite([
          { kind: "put", previousRecord: current, record: submitted },
        ]);
        return;
      } catch (cause) {
        if (!isDatabaseWriteConflict(cause)) throw cause;
      }
    }
    throw new Error("Channel ingress burst could not be completed after concurrent writes.");
  }

  return { complete, prepare, stage };
}
