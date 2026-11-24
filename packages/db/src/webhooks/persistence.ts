import type { DynamoDatabaseService, TransactionOperation } from "../client-types.ts";
import type { Ulid } from "../ids.ts";
import { key } from "../keys.ts";
import type { PlatformRecord } from "../records/index.ts";
import { transactWithSemanticEvents } from "../semantic-event-storage.ts";
import { isDatabaseWriteConflict } from "../transaction-conditions.ts";

export type WebhookEndpointRecordValue = Extract<
  PlatformRecord,
  { readonly itemType: "webhook-endpoint" }
>;
export type WebhookDeliveryRecordValue = Extract<
  PlatformRecord,
  { readonly itemType: "webhook-delivery" }
>;
export type WebhookDeliveryAttemptRecordValue = Extract<
  PlatformRecord,
  { readonly itemType: "webhook-delivery-attempt" }
>;
type SemanticEventRecordValue = Extract<PlatformRecord, { readonly itemType: "semantic-event" }>;

export interface WebhookEnvironmentScope {
  readonly environmentId: Ulid;
  readonly organizationId: Ulid;
}

/** A conditional webhook write lost a race; callers reload and re-decide. */
export class WebhookWriteConflictError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WebhookWriteConflictError";
  }
}

const ENDPOINT_PAGE_SIZE = 100;

export function webhookEndpointKey(scope: WebhookEnvironmentScope, endpointId: Ulid) {
  return {
    pk: key("ORG", scope.organizationId, "ENV", scope.environmentId),
    sk: key("WEBHOOK-ENDPOINT", endpointId),
  };
}

export function webhookDeliveryKey(scope: WebhookEnvironmentScope, deliveryId: Ulid) {
  return {
    pk: key("ORG", scope.organizationId, "ENV", scope.environmentId),
    sk: key("WEBHOOK-DELIVERY", deliveryId),
  };
}

/** Partition and sort-key prefix that hold every attempt of one delivery in attempt order. */
export function webhookDeliveryAttemptPartition(organizationId: Ulid, deliveryId: Ulid) {
  return {
    pk: key("ORG", organizationId, "WEBHOOK-DELIVERY", deliveryId),
    skPrefix: "WEBHOOK-DELIVERY-ATTEMPT#",
  };
}

async function commit(
  database: DynamoDatabaseService,
  operations: readonly TransactionOperation[],
  events: readonly SemanticEventRecordValue[] = [],
) {
  try {
    await transactWithSemanticEvents(database, operations, events);
  } catch (cause) {
    if (isDatabaseWriteConflict(cause)) {
      throw new WebhookWriteConflictError("A concurrent webhook write won the race.", { cause });
    }
    throw cause;
  }
}

export interface WebhookSemanticEventCoordinates {
  readonly aggregateId: Ulid;
  readonly aggregateType: string;
  readonly aggregateVersion: number;
  readonly organizationId: Ulid;
}

export interface WebhookPersistence {
  readonly activeEndpointPages: (
    scope: WebhookEnvironmentScope,
  ) => AsyncGenerator<readonly WebhookEndpointRecordValue[]>;
  readonly activeOrganizationEndpointPages: (
    organizationId: Ulid,
  ) => AsyncGenerator<readonly WebhookEndpointRecordValue[]>;
  readonly createDelivery: (
    record: WebhookDeliveryRecordValue,
  ) => Promise<{ readonly created: boolean; readonly record: WebhookDeliveryRecordValue }>;
  readonly nextEndpointEventVersion: (organizationId: Ulid, endpointId: Ulid) => Promise<number>;
  readonly readDelivery: (
    scope: WebhookEnvironmentScope,
    deliveryId: Ulid,
  ) => Promise<WebhookDeliveryRecordValue | undefined>;
  readonly readEndpoint: (
    scope: WebhookEnvironmentScope,
    endpointId: Ulid,
  ) => Promise<WebhookEndpointRecordValue | undefined>;
  readonly readSemanticEvent: (
    coordinates: WebhookSemanticEventCoordinates,
  ) => Promise<SemanticEventRecordValue | undefined>;
  readonly replaceDelivery: (
    previous: WebhookDeliveryRecordValue,
    next: WebhookDeliveryRecordValue,
    options?: {
      readonly activeEndpoint?: WebhookEndpointRecordValue;
      readonly attempt?: WebhookDeliveryAttemptRecordValue;
    },
  ) => Promise<WebhookDeliveryRecordValue>;
  readonly replaceEndpoint: (
    previous: WebhookEndpointRecordValue,
    next: WebhookEndpointRecordValue,
    events?: readonly SemanticEventRecordValue[],
  ) => Promise<WebhookEndpointRecordValue>;
}

/**
 * The webhook delivery runtime's persistence boundary: endpoint discovery for fan-out, delivery
 * state transitions with their immutable attempt records, endpoint health transitions, and the
 * canonical semantic event lookup used to rebuild a payload after a restart.
 */
export function makeWebhookPersistence(database: DynamoDatabaseService): WebhookPersistence {
  async function read<T extends PlatformRecord["itemType"]>(
    table: "control" | "events",
    recordKey: { readonly pk: string; readonly sk: string },
    itemType: T,
  ): Promise<Extract<PlatformRecord, { readonly itemType: T }> | undefined> {
    const record = await database.getRecord(table, recordKey, true);
    return record?.itemType === itemType
      ? (record as Extract<PlatformRecord, { readonly itemType: T }>)
      : undefined;
  }

  return {
    readEndpoint(scope: WebhookEnvironmentScope, endpointId: Ulid) {
      return read("control", webhookEndpointKey(scope, endpointId), "webhook-endpoint");
    },

    readDelivery(scope: WebhookEnvironmentScope, deliveryId: Ulid) {
      return read("events", webhookDeliveryKey(scope, deliveryId), "webhook-delivery");
    },

    readSemanticEvent(coordinates) {
      return read(
        "events",
        {
          pk: key(
            "ORG",
            coordinates.organizationId,
            "AGGREGATE",
            coordinates.aggregateType,
            coordinates.aggregateId,
          ),
          sk: key("SEMANTIC-EVENT", String(coordinates.aggregateVersion).padStart(16, "0")),
        },
        "semantic-event",
      );
    },

    /**
     * Yields pages of active endpoints in one environment: quota-slot claims first (strongly
     * consistent), then the environment's active-endpoint index for endpoints without a slot.
     * Both reads are bounded key queries; each endpoint is re-read consistently before use.
     */
    async *activeEndpointPages(
      scope: WebhookEnvironmentScope,
    ): AsyncGenerator<readonly WebhookEndpointRecordValue[]> {
      const seen = new Set<string>();
      const loadActive = async (recordKey: { readonly pk: string; readonly sk: string }) => {
        const record = await read("control", recordKey, "webhook-endpoint");
        if (
          !record ||
          record.data.status !== "active" ||
          record.data.organizationId !== scope.organizationId ||
          record.data.environmentId !== scope.environmentId ||
          seen.has(record.data.id)
        ) {
          return undefined;
        }
        seen.add(record.data.id);
        return record;
      };
      const pages = [
        {
          ConsistentRead: true,
          ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
          ExpressionAttributeValues: {
            ":pk": key("UNIQUE", `environment:${scope.environmentId}:webhook-subscription-slot`),
            ":prefix": "VALUE#",
          },
          KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
          Limit: ENDPOINT_PAGE_SIZE,
        },
        {
          ExpressionAttributeNames: { "#pk": "gsi2pk", "#sk": "gsi2sk" },
          ExpressionAttributeValues: {
            ":pk": key("ENV", scope.environmentId),
            ":prefix": "WEBHOOK-ENDPOINT#active#",
          },
          IndexName: "gsi2" as const,
          KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
          Limit: ENDPOINT_PAGE_SIZE,
        },
      ];
      for (const query of pages) {
        let exclusiveStartKey: Readonly<Record<string, unknown>> | undefined;
        do {
          const page = await database.queryRecords("control", {
            ...query,
            ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
          });
          const endpoints = (
            await Promise.all(
              page.items.flatMap((record) => {
                if (
                  record.itemType === "unique-claim" &&
                  record.data.ownerItemType === "webhook-endpoint"
                ) {
                  return [loadActive({ pk: record.data.ownerPk, sk: record.data.ownerSk })];
                }
                return record.itemType === "webhook-endpoint"
                  ? [loadActive({ pk: record.pk, sk: record.sk })]
                  : [];
              }),
            )
          ).filter((record): record is WebhookEndpointRecordValue => record !== undefined);
          if (endpoints.length > 0) yield endpoints;
          exclusiveStartKey = page.lastEvaluatedKey;
        } while (exclusiveStartKey);
      }
    },

    /**
     * Yields pages of active endpoints across every environment of one organization, for events
     * that belong to the organization or a project rather than one environment. The organization
     * resource index is eventually consistent, so an endpoint created moments before the event
     * may be missed; each listed endpoint is re-read consistently before use.
     */
    async *activeOrganizationEndpointPages(
      organizationId: Ulid,
    ): AsyncGenerator<readonly WebhookEndpointRecordValue[]> {
      let exclusiveStartKey: Readonly<Record<string, unknown>> | undefined;
      do {
        const page = await database.queryRecords("control", {
          ExpressionAttributeNames: { "#pk": "gsi1pk", "#sk": "gsi1sk" },
          ExpressionAttributeValues: {
            ":pk": key("ORG", organizationId),
            ":prefix": "WEBHOOK-ENDPOINT#active#",
          },
          IndexName: "gsi1",
          KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
          Limit: ENDPOINT_PAGE_SIZE,
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        });
        const endpoints = (
          await Promise.all(
            page.items.flatMap((listed) =>
              listed.itemType === "webhook-endpoint"
                ? [read("control", { pk: listed.pk, sk: listed.sk }, "webhook-endpoint")]
                : [],
            ),
          )
        ).filter(
          (record): record is WebhookEndpointRecordValue =>
            record?.data.status === "active" && record.data.organizationId === organizationId,
        );
        if (endpoints.length > 0) yield endpoints;
        exclusiveStartKey = page.lastEvaluatedKey;
      } while (exclusiveStartKey);
    },

    /** Create-only delivery write; a concurrent fan-out of the same event returns the winner. */
    async createDelivery(record: WebhookDeliveryRecordValue) {
      try {
        await commit(database, [{ kind: "put", record }]);
        return { created: true, record } as const;
      } catch (cause) {
        const existing = await read("events", { pk: record.pk, sk: record.sk }, "webhook-delivery");
        if (existing) return { created: false, record: existing } as const;
        throw cause;
      }
    },

    /**
     * Versioned delivery transition. `attempt` appends the attempt's immutable record in the same
     * transaction; `activeEndpoint` guards claims so an endpoint disabled or archived after it was
     * read cannot receive a new attempt.
     */
    async replaceDelivery(previous, next, options = {}) {
      const activeEndpoint = options.activeEndpoint;
      await commit(database, [
        ...(activeEndpoint
          ? [
              {
                conditionExpression: "#itemType = :itemType AND #data.#status = :active",
                expressionAttributeNames: {
                  "#data": "data",
                  "#itemType": "itemType",
                  "#status": "status",
                },
                expressionAttributeValues: { ":active": "active", ":itemType": "webhook-endpoint" },
                key: { pk: activeEndpoint.pk, sk: activeEndpoint.sk },
                kind: "condition-check" as const,
                table: "control" as const,
              },
            ]
          : []),
        { kind: "put", previousRecord: previous, record: next },
        ...(options.attempt ? [{ kind: "put" as const, record: options.attempt }] : []),
      ]);
      return next;
    },

    /** Versioned endpoint transition with its customer-visible semantic events. */
    async replaceEndpoint(
      previous: WebhookEndpointRecordValue,
      next: WebhookEndpointRecordValue,
      events: readonly SemanticEventRecordValue[] = [],
    ) {
      await commit(database, [{ kind: "put", previousRecord: previous, record: next }], events);
      return next;
    },

    async nextEndpointEventVersion(organizationId: Ulid, endpointId: Ulid) {
      const page = await database.queryRecords("events", {
        ConsistentRead: true,
        ExpressionAttributeNames: { "#pk": "pk" },
        ExpressionAttributeValues: {
          ":pk": key("ORG", organizationId, "AGGREGATE", "webhook-endpoint", endpointId),
        },
        KeyConditionExpression: "#pk = :pk",
        Limit: 1,
        ScanIndexForward: false,
      });
      const latest = page.items.find(
        (record): record is SemanticEventRecordValue => record.itemType === "semantic-event",
      );
      return latest ? latest.data.aggregateVersion + 1 : 1;
    },
  };
}
