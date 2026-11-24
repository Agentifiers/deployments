import { Schema } from "effect";
import { ChannelIngressSourceClaimRecord } from "../records/conversations.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import type {
  ChannelIngressBurstMessageInput,
  ChannelIngressBurstFlush,
  ChannelIngressBurstStageResult,
  SourceClaimRecord,
  SourceRecord,
} from "./model.ts";

export function flushForBurst(
  input: ChannelIngressBurstMessageInput,
  routeId: string,
  id: string,
  dueAt: string,
): ChannelIngressBurstFlush {
  return {
    bindingId: input.bindingId,
    burstId: id,
    dueAt,
    environmentId: input.environmentId,
    organizationId: input.organizationId,
    projectId: input.projectId,
    routeId,
  };
}

export function sourceResult(
  record: SourceRecord,
  input: ChannelIngressBurstMessageInput,
  activeFlush: ChannelIngressBurstFlush | undefined,
  observedAt: Date,
): ChannelIngressBurstStageResult {
  const ownBurstId = record.data.burstId ?? activeFlush?.burstId;
  if (!ownBurstId) throw new Error("A staged source requires its current burst head.");
  const dueAt = observedAt.toISOString();
  const flushes = [
    ...(record.data.precedingBurstId
      ? [flushForBurst(input, record.data.routeId, record.data.precedingBurstId, dueAt)]
      : []),
    record.data.burstId
      ? flushForBurst(input, record.data.routeId, record.data.burstId, dueAt)
      : activeFlush!,
  ];
  return {
    burstId: ownBurstId,
    duplicate: true,
    flushes,
    routeId: record.data.routeId,
  };
}

export function claimedSourceResult(record: SourceClaimRecord): ChannelIngressBurstStageResult {
  return {
    burstId: record.data.burstId,
    duplicate: true,
    flushes: [],
    routeId: record.data.routeId,
  };
}

export function sourceClaim(
  input: ChannelIngressBurstMessageInput,
  identity: {
    readonly burstId: string;
    readonly createdAt: string;
    readonly id: string;
    readonly routeId: string;
  },
) {
  return Schema.decodeUnknownSync(ChannelIngressSourceClaimRecord)(
    withCanonicalRecordKeys({
      data: {
        burstId: identity.burstId,
        createdAt: identity.createdAt,
        environmentId: input.environmentId,
        id: identity.id,
        organizationId: input.organizationId,
        projectId: input.projectId,
        routeId: identity.routeId,
        sourceFingerprint: input.sourceFingerprint,
        sourceMessageId: input.sourceMessageId,
      },
      itemType: "channel-ingress-source-claim" as const,
    }),
  );
}
