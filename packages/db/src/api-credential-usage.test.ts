import { describe, expect, test } from "bun:test";
import {
  createApiCredentialUsageRecorder,
  recordApiCredentialUsageBestEffort,
  type ApiCredentialUsageInput,
} from "./api-credential-usage.ts";
import type { DynamoDatabaseService } from "./client-types.ts";
import type { PlatformRecord } from "./records/index.ts";

describe("API credential usage persistence", () => {
  test("writes a canonical environment-partitioned usage record", async () => {
    let written: PlatformRecord | undefined;
    let condition: string | undefined;
    const database: DynamoDatabaseService = {
      deleteRecord: async () => {},
      getRecord: async () => undefined,
      putRecord: async (record, expression) => {
        written = record;
        condition = expression;
      },
      queryRecords: async () => ({ items: [] }),
      transactWrite: async () => {},
    };
    const recordUsage = createApiCredentialUsageRecorder({
      database,
      idFactory: () => "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
      now: () => new Date("2026-07-25T12:00:00.000Z"),
    });

    await recordUsage({
      apiCredentialId: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
      environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
      organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      outcome: "allowed",
      projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      requestMethod: "GET",
      requestPath: "/v1/usage",
    });

    expect(written).toMatchObject({
      itemType: "api-credential-usage",
      pk: "ORG#01ARZ3NDEKTSV4RRFFQ69G5FAV#ENV#01ARZ3NDEKTSV4RRFFQ69G5FAX",
      sk: "API-CREDENTIAL-USAGE#01ARZ3NDEKTSV4RRFFQ69G5FAZ",
      data: {
        apiCredentialId: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
        createdAt: "2026-07-25T12:00:00.000Z",
        outcome: "allowed",
        requestMethod: "GET",
        requestPath: "/v1/usage",
      },
    });
    expect(condition).toBe("attribute_not_exists(pk) AND attribute_not_exists(sk)");
  });

  test("isolates recorder failures from authenticated request availability", async () => {
    const failure = new Error("usage table unavailable");
    let reported: unknown;
    expect(
      recordApiCredentialUsageBestEffort(
        async () => {
          throw failure;
        },
        {
          apiCredentialId: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
          environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
          organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
          outcome: "allowed",
          projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
          requestMethod: "GET",
          requestPath: "/v1/usage",
        } satisfies ApiCredentialUsageInput,
        (error) => {
          reported = error;
        },
      ),
    ).resolves.toBeUndefined();
    expect(reported).toBe(failure);
  });

  test("bounds a stalled recorder before returning to request dispatch", async () => {
    let reported: unknown;
    expect(
      recordApiCredentialUsageBestEffort(
        () => new Promise(() => {}),
        {
          apiCredentialId: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
          environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
          organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
          outcome: "allowed",
          projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
          requestMethod: "GET",
          requestPath: "/v1/usage",
        },
        (error) => {
          reported = error;
        },
        1,
      ),
    ).resolves.toBeUndefined();
    expect(reported).toBeInstanceOf(Error);
    expect((reported as Error).message).toContain("timed out");
  });
});
