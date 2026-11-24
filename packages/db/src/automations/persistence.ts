import type { DynamoDatabaseService } from "../client-types.ts";
import { key } from "../keys.ts";
import type { PlatformRecord } from "../records/index.ts";

type AutomationRecord = Extract<PlatformRecord, { readonly itemType: "heartbeat" | "schedule" }>;

export type AutomationRecordLocator =
  | {
      readonly environmentId: string;
      readonly id: string;
      readonly itemType: "agent-deployment" | "agent-release" | "schedule" | "workspace";
      readonly kind: "environment-resource";
      readonly organizationId: string;
    }
  | {
      readonly aggregateId: string;
      readonly aggregateType: "heartbeat" | "schedule";
      readonly kind: "creation-event";
      readonly organizationId: string;
    }
  | {
      readonly agentDeploymentId: string;
      readonly heartbeatId: string;
      readonly kind: "heartbeat";
      readonly organizationId: string;
    }
  | {
      readonly heartbeatId: string;
      readonly heartbeatRunId: string;
      readonly kind: "heartbeat-run";
      readonly organizationId: string;
    }
  | {
      readonly fireKey: string;
      readonly kind: "schedule-fire";
      readonly organizationId: string;
      readonly scheduleId: string;
    }
  | {
      readonly kind: "thread";
      readonly organizationId: string;
      readonly threadId: string;
    };

function environmentPartition(locator: {
  readonly environmentId: string;
  readonly organizationId: string;
}) {
  return key("ORG", locator.organizationId, "ENV", locator.environmentId);
}

export function automationScheduleFireSortKey(scheduleId: string, fireKey: string) {
  return key("SCHEDULE-FIRE", scheduleId, fireKey);
}

function locatorKey(locator: AutomationRecordLocator): {
  readonly key: { readonly pk: string; readonly sk: string };
  readonly table: "control" | "events" | "execution";
} {
  switch (locator.kind) {
    case "environment-resource":
      return {
        key: {
          pk: environmentPartition(locator),
          sk: key(locator.itemType.toUpperCase(), locator.id),
        },
        table: "control",
      };
    case "creation-event":
      return {
        key: {
          pk: key(
            "ORG",
            locator.organizationId,
            "AGGREGATE",
            locator.aggregateType,
            locator.aggregateId,
          ),
          sk: key("SEMANTIC-EVENT", "0000000000000001"),
        },
        table: "events",
      };
    case "heartbeat":
      return {
        key: {
          pk: key("ORG", locator.organizationId, "AGENT-DEPLOYMENT", locator.agentDeploymentId),
          sk: key("HEARTBEAT", locator.heartbeatId),
        },
        table: "execution",
      };
    case "heartbeat-run":
      return {
        key: {
          pk: key("ORG", locator.organizationId, "HEARTBEAT", locator.heartbeatId),
          sk: key("HEARTBEAT-RUN", locator.heartbeatRunId),
        },
        table: "execution",
      };
    case "schedule-fire":
      return {
        key: {
          pk: key("ORG", locator.organizationId, "SCHEDULE", locator.scheduleId),
          sk: automationScheduleFireSortKey(locator.scheduleId, locator.fireKey),
        },
        table: "execution",
      };
    case "thread":
      return {
        key: {
          pk: key("ORG", locator.organizationId, "THREAD", locator.threadId),
          sk: key("THREAD", locator.threadId),
        },
        table: "execution",
      };
  }
}

export function makeAutomationPersistence(database: DynamoDatabaseService) {
  return {
    async get(locator: AutomationRecordLocator): Promise<PlatformRecord | undefined> {
      const location = locatorKey(locator);
      return database.getRecord(location.table, location.key, true);
    },

    async getCurrent(record: AutomationRecord): Promise<PlatformRecord | undefined> {
      const table = record.itemType === "schedule" ? "control" : "execution";
      return database.getRecord(table, { pk: record.pk, sk: record.sk }, true);
    },

    async hasAcceptedScheduleFire(input: {
      readonly organizationId: string;
      readonly scheduleId: string;
      readonly scheduleVersion: number;
    }): Promise<boolean> {
      let exclusiveStartKey: Readonly<Record<string, unknown>> | undefined;
      do {
        const page = await database.queryRecords("execution", {
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
          ConsistentRead: true,
          ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
          ExpressionAttributeValues: {
            ":pk": key("ORG", input.organizationId, "SCHEDULE", input.scheduleId),
            ":prefix": `SCHEDULE-FIRE#${input.scheduleId}#`,
          },
          KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
          Limit: 100,
        });
        if (
          page.items.some(
            (item) =>
              item.itemType === "schedule-fire" &&
              item.data.status === "accepted" &&
              item.data.scheduleVersion === input.scheduleVersion,
          )
        ) {
          return true;
        }
        exclusiveStartKey = page.lastEvaluatedKey;
      } while (exclusiveStartKey);
      return false;
    },
  };
}
