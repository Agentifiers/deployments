import { describe, expect, it } from "bun:test";
import { type DynamoDatabaseService, type Ulid } from "@deployments-ai/db";
import { MAX_FILTERED_PAGE_QUERIES, queryEnvironmentRecordPage } from "./platform-shared.ts";
import { InvalidMemoryPageCursorError, type MemorySpace } from "./platform-types.ts";

const environmentId = "01ARZ3NDEKTSV4RRFFQ69G5FA2" as Ulid;

describe("memory filtered pagination bounds", () => {
  it("returns a continuation cursor after the maximum filtered query count", async () => {
    let queryCount = 0;
    const database = {
      queryRecords: async () => {
        queryCount += 1;
        return {
          items: [],
          lastEvaluatedKey: {
            gsi2pk: `ENV#${environmentId}`,
            gsi2sk: `MEMORY-SPACE#active#2026-07-23T00:00:00.000Z#${queryCount}`,
            pk: `ORG#01ARZ3NDEKTSV4RRFFQ69G5FA5#ENV#${environmentId}`,
            sk: `MEMORY-SPACE#${queryCount}`,
          },
        };
      },
    } as unknown as DynamoDatabaseService;
    const cursorCodec = {
      open: async (value: string) => Buffer.from(value, "base64url").toString("utf8"),
      seal: async (value: string) => Buffer.from(value).toString("base64url"),
    };

    const page = await queryEnvironmentRecordPage<MemorySpace>({
      cursorCodec,
      database,
      environmentId,
      filter: () => false,
      itemType: "memory-space",
      limit: 1,
      table: "control",
    });

    expect(queryCount).toBe(MAX_FILTERED_PAGE_QUERIES);
    expect(page.items).toEqual([]);
    const envelope = JSON.parse(
      Buffer.from(page.nextCursor!, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(envelope).toMatchObject({ itemType: "memory-space", version: 2 });
    expect(envelope).not.toHaveProperty("key");
    expect(page.nextCursor).not.toContain(`MEMORY-SPACE#${MAX_FILTERED_PAGE_QUERIES}`);

    await queryEnvironmentRecordPage<MemorySpace>({
      cursor: page.nextCursor!,
      cursorCodec,
      database,
      environmentId,
      filter: () => false,
      itemType: "memory-space",
      limit: 1,
      table: "control",
    });
    expect(queryCount).toBe(MAX_FILTERED_PAGE_QUERIES * 2);
  });

  it("keeps cursor codec outages retryable", async () => {
    const cursor = Buffer.from(
      JSON.stringify({ itemType: "memory-space", token: "encrypted", version: 2 }),
    ).toString("base64url");
    const database = {
      queryRecords: async () => ({ items: [] }),
    } as unknown as DynamoDatabaseService;

    expect(
      queryEnvironmentRecordPage<MemorySpace>({
        cursor,
        cursorCodec: {
          open: async () => {
            throw new Error("KMS unavailable");
          },
          seal: async (value) => value,
        },
        database,
        environmentId,
        filter: () => true,
        itemType: "memory-space",
        table: "control",
      }),
    ).rejects.toMatchObject({ code: "cursor_unavailable", statusCode: 503 });
  });

  it("keeps cursor sealing outages retryable", async () => {
    const database = {
      queryRecords: async () => ({
        items: [],
        lastEvaluatedKey: {
          gsi2pk: `ENV#${environmentId}`,
          gsi2sk: "MEMORY-SPACE#active#2026-07-23T00:00:00.000Z#1",
          pk: `ORG#01ARZ3NDEKTSV4RRFFQ69G5FA5#ENV#${environmentId}`,
          sk: "MEMORY-SPACE#1",
        },
      }),
    } as unknown as DynamoDatabaseService;

    expect(
      queryEnvironmentRecordPage<MemorySpace>({
        cursorCodec: {
          open: async (value) => value,
          seal: async () => {
            throw new Error("KMS unavailable");
          },
        },
        database,
        environmentId,
        filter: () => false,
        itemType: "memory-space",
        limit: 1,
        table: "control",
      }),
    ).rejects.toMatchObject({ code: "cursor_unavailable", statusCode: 503 });
  });

  it("reports explicit invalid ciphertext as a client cursor error", async () => {
    const cursor = Buffer.from(
      JSON.stringify({ itemType: "memory-space", token: "encrypted", version: 2 }),
    ).toString("base64url");
    const database = {
      queryRecords: async () => ({ items: [] }),
    } as unknown as DynamoDatabaseService;

    expect(
      queryEnvironmentRecordPage<MemorySpace>({
        cursor,
        cursorCodec: {
          open: async () => {
            throw new InvalidMemoryPageCursorError("invalid");
          },
          seal: async (value) => value,
        },
        database,
        environmentId,
        filter: () => true,
        itemType: "memory-space",
        table: "control",
      }),
    ).rejects.toMatchObject({ code: "invalid_cursor", statusCode: 400 });
  });
});
