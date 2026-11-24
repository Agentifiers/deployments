import { describe, expect, test } from "bun:test";

import {
  InvalidAgentRecordCursorError,
  makeAgentLifecycleRecordStore,
} from "./agent-lifecycle-storage.ts";
import { type DynamoDatabaseService, type RecordKey } from "./client-types.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const OTHER_ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const RESOURCE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB0";

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

describe("agent lifecycle record store", () => {
  test("derives environment record keys inside the db package", async () => {
    let observedKey: RecordKey | undefined;
    const store = makeAgentLifecycleRecordStore(
      database({
        getRecord: async (_table, key) => {
          observedKey = key;
          return undefined;
        },
      }),
    );

    await store.getEnvironmentRecord(
      { environmentId: ENVIRONMENT_ID, organizationId: ORGANIZATION_ID },
      "agent-definition",
      RESOURCE_ID,
    );

    expect(observedKey).toEqual({
      pk: `ORG#${ORGANIZATION_ID}#ENV#${ENVIRONMENT_ID}`,
      sk: `AGENT-DEFINITION#${RESOURCE_ID}`,
    });
  });

  test("keeps index keys in an opaque, collection-scoped cursor", async () => {
    const queries: Record<string, unknown>[] = [];
    const lastEvaluatedKey = {
      gsi2pk: `ENV#${ENVIRONMENT_ID}`,
      gsi2sk: `AGENT-DEFINITION#active#2026-07-25T12%3A00%3A00.000Z#${RESOURCE_ID}`,
      pk: `ORG#${ORGANIZATION_ID}#ENV#${ENVIRONMENT_ID}`,
      sk: `AGENT-DEFINITION#${RESOURCE_ID}`,
    };
    const store = makeAgentLifecycleRecordStore(
      database({
        queryRecords: async (_table, input) => {
          queries.push(input as Record<string, unknown>);
          return queries.length === 1 ? { items: [], lastEvaluatedKey } : { items: [] };
        },
      }),
    );

    const first = await store.listEnvironmentRecords(ENVIRONMENT_ID, "agent-definition", {
      limit: 25,
    });
    expect(first.nextCursor).toBeString();
    expect(first.nextCursor).not.toContain(ENVIRONMENT_ID);

    await store.listEnvironmentRecords(ENVIRONMENT_ID, "agent-definition", {
      cursor: first.nextCursor!,
      limit: 25,
    });
    expect(queries[1]).toMatchObject({ ExclusiveStartKey: lastEvaluatedKey });

    expect(
      store.listEnvironmentRecords(OTHER_ENVIRONMENT_ID, "agent-definition", {
        cursor: first.nextCursor!,
        limit: 25,
      }),
    ).rejects.toBeInstanceOf(InvalidAgentRecordCursorError);
  });

  test("rejects cursors with unexpected physical key fields", async () => {
    const malformedCursor = Buffer.from(
      JSON.stringify({
        index: "gsi2",
        key: {
          gsi1pk: "unexpected",
          gsi2pk: `ENV#${ENVIRONMENT_ID}`,
          gsi2sk: `AGENT-DEFINITION#active#2026-07-25T12%3A00%3A00.000Z#${RESOURCE_ID}`,
          pk: `ORG#${ORGANIZATION_ID}#ENV#${ENVIRONMENT_ID}`,
          sk: `AGENT-DEFINITION#${RESOURCE_ID}`,
        },
        version: 1,
      }),
    ).toString("base64url");
    const store = makeAgentLifecycleRecordStore(database());

    expect(
      store.listEnvironmentRecords(ENVIRONMENT_ID, "agent-definition", {
        cursor: malformedCursor,
        limit: 25,
      }),
    ).rejects.toBeInstanceOf(InvalidAgentRecordCursorError);
  });
});
