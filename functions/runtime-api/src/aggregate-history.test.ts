import { describe, expect, test } from "bun:test";
import {
  key,
  type DynamoDatabaseService,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import { listAutomationHistory } from "./aggregate-history.ts";

const id = (suffix: string) => `01ARZ3NDEKTSV4RRFFQ69G${suffix.padStart(4, "0")}` as Ulid;

describe("automation fire history", () => {
  test("queries aggregate history newest-first and returns a portable cursor", async () => {
    const queries: unknown[] = [];
    const lastEvaluatedKey = {
      gsi1pk: "aggregate-partition",
      gsi1sk: "2026-07-25T12:00:00.000Z",
      pk: "base-partition",
      sk: "base-sort",
    };
    const scheduleFire = { itemType: "schedule-fire" } as PlatformRecord;
    const unrelated = { itemType: "heartbeat-run" } as PlatformRecord;
    const database = {
      queryRecords: async (
        _table: Parameters<DynamoDatabaseService["queryRecords"]>[0],
        input: Parameters<DynamoDatabaseService["queryRecords"]>[1],
      ) => {
        queries.push(input);
        return { items: [scheduleFire, unrelated], lastEvaluatedKey };
      },
    } as unknown as DynamoDatabaseService;

    const page = await listAutomationHistory(database, {
      id: id("2"),
      limit: 10,
      organizationId: id("1"),
      type: "schedule",
    });

    expect(page.items).toEqual([scheduleFire]);
    expect(queries).toEqual([
      expect.objectContaining({
        ExpressionAttributeValues: {
          ":pk": key("ORG", id("1"), "SCHEDULE", id("2"), "FIRES"),
        },
        IndexName: "gsi1",
        Limit: 10,
        ScanIndexForward: false,
      }),
    ]);
    expect(JSON.parse(Buffer.from(page.nextCursor!, "base64url").toString("utf8"))).toEqual(
      lastEvaluatedKey,
    );
  });

  test("rejects malformed cursors and out-of-range limits", async () => {
    const database = {
      queryRecords: () => Promise.resolve({ items: [] }),
    } as unknown as DynamoDatabaseService;
    const input = {
      id: id("2"),
      organizationId: id("1"),
      type: "heartbeat" as const,
    };

    expect(
      listAutomationHistory(database, { ...input, cursor: "not-a-cursor" }),
    ).rejects.toMatchObject({ code: "invalid_cursor", status: 400 });
    expect(listAutomationHistory(database, { ...input, limit: 0 })).rejects.toMatchObject({
      code: "invalid_limit",
      status: 400,
    });

    const expectedPartition = key("ORG", id("1"), "HEARTBEAT", id("2"), "FIRES");
    const cursor = (value: Readonly<Record<string, unknown>>) =>
      Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    const validShape = {
      gsi1pk: expectedPartition,
      gsi1sk: "2026-07-25T12%3A00%3A00.000Z#record",
      pk: key("ORG", id("1"), "HEARTBEAT", id("2")),
      sk: "HEARTBEAT-RUN#record",
    };
    expect(
      listAutomationHistory(database, {
        ...input,
        cursor: cursor({ ...validShape, gsi1pk: "ORG#another#HEARTBEAT#history#FIRES" }),
      }),
    ).rejects.toMatchObject({ code: "invalid_cursor", status: 400 });
    expect(
      listAutomationHistory(database, {
        ...input,
        cursor: cursor({ ...validShape, extra: "field" }),
      }),
    ).rejects.toMatchObject({ code: "invalid_cursor", status: 400 });
    expect(
      listAutomationHistory(database, {
        ...input,
        cursor: cursor({ ...validShape, gsi1sk: "x".repeat(1_025) }),
      }),
    ).rejects.toMatchObject({ code: "invalid_cursor", status: 400 });
  });
});
