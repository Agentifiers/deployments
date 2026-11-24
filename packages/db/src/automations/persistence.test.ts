import { describe, expect, test } from "bun:test";
import type { DynamoDatabaseService, RecordKey } from "../client-types.ts";
import { makeAutomationPersistence } from "./persistence.ts";

function database(overrides: Partial<DynamoDatabaseService> = {}): DynamoDatabaseService {
  return {
    deleteRecord: async () => {},
    getRecord: async () => undefined,
    putRecord: async () => {},
    queryRecords: async () => ({ items: [] }),
    transactWrite: async () => {},
    ...overrides,
  };
}

describe("automation persistence", () => {
  test("derives heartbeat and schedule-fire keys inside packages/db", async () => {
    const reads: { readonly key: RecordKey; readonly table: string }[] = [];
    const persistence = makeAutomationPersistence(
      database({
        getRecord: async (table, key) => {
          reads.push({ key, table });
          return undefined;
        },
      }),
    );

    await persistence.get({
      agentDeploymentId: "deployment-id",
      heartbeatId: "heartbeat-id",
      kind: "heartbeat",
      organizationId: "organization-id",
    });
    await persistence.get({
      fireKey: "fire-key",
      kind: "schedule-fire",
      organizationId: "organization-id",
      scheduleId: "schedule-id",
    });

    expect(reads).toEqual([
      {
        key: {
          pk: "ORG#organization-id#AGENT-DEPLOYMENT#deployment-id",
          sk: "HEARTBEAT#heartbeat-id",
        },
        table: "execution",
      },
      {
        key: {
          pk: "ORG#organization-id#SCHEDULE#schedule-id",
          sk: "SCHEDULE-FIRE#schedule-id#fire-key",
        },
        table: "execution",
      },
    ]);
  });

  test("owns accepted-fire query construction", async () => {
    let query: Readonly<Record<string, unknown>> | undefined;
    const persistence = makeAutomationPersistence(
      database({
        queryRecords: async (_table, input) => {
          query = input;
          return { items: [] };
        },
      }),
    );

    await persistence.hasAcceptedScheduleFire({
      organizationId: "organization-id",
      scheduleId: "schedule-id",
      scheduleVersion: 2,
    });

    expect(query).toMatchObject({
      ExpressionAttributeValues: {
        ":pk": "ORG#organization-id#SCHEDULE#schedule-id",
        ":prefix": "SCHEDULE-FIRE#schedule-id#",
      },
      Limit: 100,
    });
  });
});
