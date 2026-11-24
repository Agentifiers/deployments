import type { DynamoDatabaseService, TransactionOperation } from "../client-types.ts";
import type { Ulid } from "../ids.ts";
import { channelIngressHeadKey } from "./keys.ts";

export interface ChannelIngressDispatchBoundary {
  readonly bindingId: Ulid;
  readonly environmentId: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly routeId: string;
  readonly throughSequence: number;
}

export type ChannelIngressDispatchAssessment =
  | { readonly condition: TransactionOperation; readonly kind: "current" }
  | { readonly kind: "superseded" };

export function makeChannelIngressDispatchPersistence(database: DynamoDatabaseService) {
  return {
    async assess(
      boundary: ChannelIngressDispatchBoundary,
    ): Promise<ChannelIngressDispatchAssessment> {
      const value = await database.getRecord(
        "execution",
        channelIngressHeadKey(boundary.organizationId, boundary.routeId),
        true,
      );
      if (!value || value.itemType !== "channel-ingress-burst-head") {
        throw new Error("Channel ingress route head is unavailable at delivery dispatch.");
      }
      const routeBindingId = value.data.route.bindingId;
      if (
        value.data.id !== boundary.routeId ||
        value.data.routeId !== boundary.routeId ||
        value.data.organizationId !== boundary.organizationId ||
        value.data.projectId !== boundary.projectId ||
        value.data.environmentId !== boundary.environmentId ||
        routeBindingId !== boundary.bindingId
      ) {
        throw new Error("Channel ingress delivery boundary does not match its route head.");
      }
      const expectedNextSequence = boundary.throughSequence + 1;
      if (value.data.nextSequence > expectedNextSequence) return { kind: "superseded" };
      if (value.data.nextSequence !== expectedNextSequence) {
        throw new Error("Channel ingress route head precedes its prepared delivery boundary.");
      }
      return {
        condition: {
          conditionExpression:
            "#itemType = :itemType AND #data.#version = :version AND #data.#routeId = :routeId AND #data.#nextSequence = :nextSequence AND #data.#environmentId = :environmentId AND #data.#projectId = :projectId AND #data.#route.#bindingId = :bindingId",
          expressionAttributeNames: {
            "#bindingId": "bindingId",
            "#data": "data",
            "#environmentId": "environmentId",
            "#itemType": "itemType",
            "#nextSequence": "nextSequence",
            "#projectId": "projectId",
            "#route": "route",
            "#routeId": "routeId",
            "#version": "version",
          },
          expressionAttributeValues: {
            ":bindingId": boundary.bindingId,
            ":environmentId": boundary.environmentId,
            ":itemType": "channel-ingress-burst-head",
            ":nextSequence": expectedNextSequence,
            ":projectId": boundary.projectId,
            ":routeId": boundary.routeId,
            ":version": value.data.version,
          },
          key: { pk: value.pk, sk: value.sk },
          kind: "condition-check",
          table: "execution",
        },
        kind: "current",
      };
    },
  };
}
