import { createHash } from "node:crypto";
import type { Ulid } from "../ids.ts";
import { key } from "../keys.ts";
import type { ChannelIngressBurstRoute } from "./model.ts";

function digest(parts: readonly string[]) {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function channelIngressBurstRouteId(route: ChannelIngressBurstRoute) {
  return digest([
    "channel-ingress-route-v1",
    route.bindingId,
    route.provider,
    route.externalAccountId ?? "",
    route.externalWorkspaceId ?? "",
    route.channel,
    route.executor ?? "",
    route.externalChannelId,
    route.externalThreadKey,
  ]);
}

export function channelIngressSourceRecordId(routeId: string, sourceMessageId: string) {
  return digest(["channel-ingress-source-v1", routeId, sourceMessageId]);
}

export function channelIngressBurstId(
  routeId: string,
  firstSourceRecordId: string,
  sequence: number,
) {
  return digest(["channel-ingress-burst-v2", routeId, firstSourceRecordId, String(sequence)]);
}

function routePartition(organizationId: Ulid, routeId: string) {
  return key("ORG", organizationId, "ROUTE", routeId);
}

export function channelIngressHeadKey(organizationId: Ulid, routeId: string) {
  return {
    pk: routePartition(organizationId, routeId),
    sk: key("CHANNEL-INGRESS-BURST-HEAD", routeId),
  };
}

export function channelIngressSourceKey(organizationId: Ulid, routeId: string, id: string) {
  return {
    pk: routePartition(organizationId, routeId),
    sk: key("CHANNEL-INGRESS-SOURCE", id),
  };
}

export function channelIngressSourceClaimKey(organizationId: Ulid, routeId: string, id: string) {
  return {
    pk: routePartition(organizationId, routeId),
    sk: key("CHANNEL-INGRESS-SOURCE-CLAIM", id),
  };
}

export function channelIngressBurstKey(organizationId: Ulid, routeId: string, id: string) {
  return {
    pk: routePartition(organizationId, routeId),
    sk: key("CHANNEL-INGRESS-BURST", id),
  };
}
