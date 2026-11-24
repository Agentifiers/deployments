import { describe, expect, test } from "bun:test";
import type { DynamoDatabaseService, RecordKey } from "../client-types.ts";
import { makeRunMessagePersistence } from "./run-message-persistence.ts";

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

describe("run message persistence", () => {
  test("owns completion evidence and message record locations", async () => {
    let query: Readonly<Record<string, unknown>> | undefined;
    let read: RecordKey | undefined;
    const persistence = makeRunMessagePersistence(
      database({
        getRecord: async (_table, key) => {
          read = key;
          return undefined;
        },
        queryRecords: async (_table, input) => {
          query = input;
          return { items: [] };
        },
      }),
    );

    await persistence.getCompletionEvents({
      organizationId: "organization-id",
      runId: "run-id",
      sequence: 3,
    });
    await persistence.getMessage({
      messageId: "message-id",
      organizationId: "organization-id",
      sequence: 9,
      threadId: "thread-id",
    });

    expect(query).toMatchObject({
      ExpressionAttributeValues: {
        ":pk": "ORG#organization-id#RUN#run-id",
        ":prefix": "TIMELINE-EVENT#0000000000000003",
      },
      Limit: 2,
    });
    expect(read).toEqual({
      pk: "ORG#organization-id#THREAD#thread-id",
      sk: "MESSAGE#0000000000000009#message-id",
    });
  });
});
