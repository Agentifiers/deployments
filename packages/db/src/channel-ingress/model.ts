import type { DynamoDatabaseService } from "../client-types.ts";
import type { Ulid } from "../ids.ts";
import type { DynamoValue } from "../record-schema.ts";
import type { PlatformRecord } from "../records/index.ts";

export type BurstHead = Extract<
  PlatformRecord,
  { readonly itemType: "channel-ingress-burst-head" }
>;
export type BurstRecord = Extract<PlatformRecord, { readonly itemType: "channel-ingress-burst" }>;
export type SourceClaimRecord = Extract<
  PlatformRecord,
  { readonly itemType: "channel-ingress-source-claim" }
>;
export type SourceRecord = Extract<PlatformRecord, { readonly itemType: "channel-ingress-source" }>;

export const DEFAULT_QUIET_PERIOD_MS = 1_500;
export const DEFAULT_MAX_MESSAGES = 20;
export const DEFAULT_MAX_ATTACHMENTS = 20;
// Match the conversation service's existing user-message contract. Separators count toward this
// total, so a composite never exceeds what submitTurn already accepts.
export const DEFAULT_MAX_CONTENT_BYTES = 256 * 1_024;
export const DEFAULT_MAX_METADATA_BYTES = 60 * 1_024;
export const DEFAULT_MAX_SINGLETON_METADATA_BYTES = 64 * 1_024;
export const DEFAULT_MAX_PAYLOAD_BYTES = 320 * 1_024;
// The flush queue can retain a command for four days and its DLQ for another fourteen.
// Keep immutable burst/source state beyond that full redrive horizon so a late recovery
// cannot lose or regroup any already-accepted source message.
export const RETENTION_MS = 30 * 24 * 60 * 60_000;
export const PREDECESSOR_RETRY_DELAY_MS = 1_000;
export const WRITE_ATTEMPTS = 8;

export interface ChannelIngressBurstRoute {
  readonly bindingId: Ulid;
  readonly channel: string;
  readonly executor?: string;
  readonly externalAccountId?: string;
  readonly externalChannelId: string;
  readonly externalThreadKey: string;
  readonly externalWorkspaceId?: string;
  readonly provider: string;
}

export interface ChannelIngressBurstMessageInput {
  readonly attachmentCount?: number;
  readonly bindingId: Ulid;
  readonly contentBytes: number;
  readonly environmentId: Ulid;
  readonly metadataBytes?: number;
  readonly organizationId: Ulid;
  readonly payload: Readonly<Record<string, DynamoValue>>;
  readonly payloadBytes?: number;
  readonly projectId: Ulid;
  readonly receivedAt: string;
  readonly route: ChannelIngressBurstRoute;
  readonly senderId: string;
  readonly sourceFingerprint: string;
  readonly sourceMessageId: string;
}

export interface ChannelIngressBurstFlush {
  readonly bindingId: Ulid;
  readonly burstId: string;
  readonly dueAt: string;
  readonly environmentId: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly routeId: string;
}

export interface ChannelIngressBurstStageResult {
  readonly burstId: string;
  readonly duplicate: boolean;
  readonly flushes: readonly ChannelIngressBurstFlush[];
  readonly routeId: string;
}

export type ChannelIngressBurstPreparation =
  | {
      readonly dueAt: string;
      readonly kind: "waiting";
      readonly waitFor: "predecessor" | "quiet-window";
    }
  | { readonly kind: "superseded" }
  | {
      readonly burstId: string;
      readonly kind: "ready";
      readonly payloads: readonly Readonly<Record<string, DynamoValue>>[];
      readonly routeId: string;
      readonly sourceMessageIds: readonly string[];
      readonly throughSequence: number;
    };

export interface ChannelIngressBurstPersistence {
  readonly complete: (flush: ChannelIngressBurstFlush) => Promise<void>;
  readonly prepare: (flush: ChannelIngressBurstFlush) => Promise<ChannelIngressBurstPreparation>;
  readonly stage: (
    input: ChannelIngressBurstMessageInput,
  ) => Promise<ChannelIngressBurstStageResult>;
}

export interface ChannelIngressBurstPersistenceOptions {
  readonly database: DynamoDatabaseService;
  readonly maxAttachments?: number;
  readonly maxContentBytes?: number;
  readonly maxMessages?: number;
  readonly maxMetadataBytes?: number;
  readonly maxSingletonMetadataBytes?: number;
  readonly maxPayloadBytes?: number;
  readonly now?: () => Date;
  readonly quietPeriodMs?: number;
}

export function canonicalTimestamp(value: string, label: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error(`${label} must be a canonical UTC timestamp.`);
  }
  return timestamp;
}

export function canonicalNow(now: () => Date) {
  const value = now();
  if (!Number.isFinite(value.getTime())) throw new Error("Current time is invalid.");
  return value;
}

export function expiresAt(now: Date) {
  return new Date(now.getTime() + RETENTION_MS).toISOString();
}

export function assertRetained(record: BurstRecord | SourceRecord, observedAt: Date) {
  if (Date.parse(record.data.expiresAt) <= observedAt.getTime()) {
    throw new Error(`The ${record.itemType} record has logically expired.`);
  }
}

export function ttl(value: string) {
  return Math.floor(Date.parse(value) / 1_000);
}

export function asRoute(route: ChannelIngressBurstRoute): Readonly<Record<string, DynamoValue>> {
  return {
    bindingId: route.bindingId,
    channel: route.channel,
    ...(route.executor ? { executor: route.executor } : {}),
    ...(route.externalAccountId ? { externalAccountId: route.externalAccountId } : {}),
    externalChannelId: route.externalChannelId,
    externalThreadKey: route.externalThreadKey,
    ...(route.externalWorkspaceId ? { externalWorkspaceId: route.externalWorkspaceId } : {}),
    provider: route.provider,
  };
}

export function scopeMatches(
  record: BurstHead | BurstRecord | SourceClaimRecord | SourceRecord,
  scope: {
    readonly environmentId: Ulid;
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
  },
) {
  return (
    record.data.organizationId === scope.organizationId &&
    record.data.projectId === scope.projectId &&
    record.data.environmentId === scope.environmentId
  );
}

export function crossesQuietWindow(pending: BurstHead["data"]["pending"], quietPeriodMs: number) {
  const orderedTimes = pending
    .map(({ receivedAt }) => Date.parse(receivedAt))
    .toSorted((left, right) => left - right);
  return orderedTimes.some(
    (timestamp, index) => index > 0 && timestamp - orderedTimes[index - 1]! >= quietPeriodMs,
  );
}

export function validateSourceClaim(
  record: SourceClaimRecord,
  input: ChannelIngressBurstMessageInput,
  routeId: string,
  id: string,
) {
  if (
    !scopeMatches(record, input) ||
    record.data.id !== id ||
    record.data.routeId !== routeId ||
    record.data.sourceMessageId !== input.sourceMessageId ||
    record.data.sourceFingerprint !== input.sourceFingerprint
  ) {
    throw new Error("An inbound source message ID was reused with different content or scope.");
  }
}

export function validateSource(
  record: SourceRecord,
  input: ChannelIngressBurstMessageInput,
  routeId: string,
) {
  if (
    !scopeMatches(record, input) ||
    record.data.routeId !== routeId ||
    record.data.senderId !== input.senderId ||
    record.data.sourceMessageId !== input.sourceMessageId ||
    record.data.sourceFingerprint !== input.sourceFingerprint
  ) {
    throw new Error("An inbound source message ID was reused with different content or scope.");
  }
}

export function validateFlushScope(
  record: BurstHead | BurstRecord,
  flush: ChannelIngressBurstFlush,
) {
  if (
    !scopeMatches(record, flush) ||
    record.data.routeId !== flush.routeId ||
    (record.itemType === "channel-ingress-burst" && record.data.id !== flush.burstId)
  ) {
    throw new Error("The inbound burst flush does not match stored scope.");
  }
}

export function readBurst(record: PlatformRecord | undefined, flush: ChannelIngressBurstFlush) {
  if (!record) return undefined;
  if (record.itemType !== "channel-ingress-burst") {
    throw new Error("The inbound burst key resolved to a different record type.");
  }
  validateFlushScope(record, flush);
  return record;
}

export function ready(record: BurstRecord): ChannelIngressBurstPreparation {
  if (record.data.status !== "prepared") {
    throw new Error("Only a prepared inbound burst can become ready.");
  }
  return {
    burstId: record.data.id,
    kind: "ready",
    payloads: record.data.payloads,
    routeId: record.data.routeId,
    sourceMessageIds: record.data.sourceMessageIds,
    throughSequence: record.data.throughSequence,
  };
}

export function validateLinkedBurst(
  record: PlatformRecord | undefined,
  owner: BurstHead | BurstRecord,
) {
  if (!record || record.itemType !== "channel-ingress-burst") {
    throw new Error("The preceding inbound burst is unavailable.");
  }
  if (!scopeMatches(record, owner.data) || record.data.routeId !== owner.data.routeId) {
    throw new Error("The preceding inbound burst does not match its conversation route.");
  }
  return record;
}

export function positiveLimit(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return value;
}
