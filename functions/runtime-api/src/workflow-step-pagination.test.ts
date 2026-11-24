import { describe, expect, test } from "bun:test";
import {
  key,
  type DynamoDatabaseService,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import { listWorkflowStepAttempts, publicWorkflowStepPage } from "./workflow-step-pagination.ts";

const organizationId = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid;
const executionId = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as Ulid;

describe("workflow step pagination", () => {
  test("queries one execution aggregate and returns only step attempts", async () => {
    const queries: unknown[] = [];
    const partition = key("ORG", organizationId, "WORKFLOW-EXECUTION", executionId);
    const lastEvaluatedKey = {
      pk: partition,
      sk: "WORKFLOW-STEP-ATTEMPT#01ARZ3NDEKTSV4RRFFQ69G5FAX",
    };
    const attempt = { itemType: "workflow-step-attempt" } as Extract<
      PlatformRecord,
      { readonly itemType: "workflow-step-attempt" }
    >;
    const database = {
      queryRecords: (_table: string, input: unknown) => {
        queries.push(input);
        return Promise.resolve({
          items: [attempt, { itemType: "workflow-approval" } as PlatformRecord],
          lastEvaluatedKey,
        });
      },
    } as unknown as DynamoDatabaseService;

    const page = await listWorkflowStepAttempts(database, organizationId, executionId, {
      limit: 10,
    });
    expect(page.items).toEqual([attempt]);
    expect(queries[0]).toMatchObject({
      ConsistentRead: true,
      ExpressionAttributeValues: {
        ":pk": partition,
        ":prefix": "WORKFLOW-STEP-ATTEMPT#",
      },
      Limit: 10,
      ScanIndexForward: true,
    });
    expect(JSON.parse(Buffer.from(page.nextCursor!, "base64url").toString("utf8"))).toEqual(
      lastEvaluatedKey,
    );
  });

  test("rejects a cursor from another workflow execution", async () => {
    const database = {
      queryRecords: () => Promise.resolve({ items: [] }),
    } as unknown as DynamoDatabaseService;
    const cursor = Buffer.from(
      JSON.stringify({
        pk: key("ORG", organizationId, "WORKFLOW-EXECUTION", organizationId),
        sk: "WORKFLOW-STEP-ATTEMPT#01ARZ3NDEKTSV4RRFFQ69G5FAX",
      }),
      "utf8",
    ).toString("base64url");
    expect(
      listWorkflowStepAttempts(database, organizationId, executionId, { cursor }),
    ).rejects.toMatchObject({ code: "invalid_cursor", status: 400 });
  });

  test("returns a cursor before a projected step page exceeds its response budget", () => {
    const partition = key("ORG", organizationId, "WORKFLOW-EXECUTION", executionId);
    const records = ["01ARZ3NDEKTSV4RRFFQ69G5FAX", "01ARZ3NDEKTSV4RRFFQ69G5FAY"].map(
      (id) =>
        ({
          itemType: "workflow-step-attempt",
          pk: partition,
          sk: `WORKFLOW-STEP-ATTEMPT#${id}`,
        }) as Extract<PlatformRecord, { readonly itemType: "workflow-step-attempt" }>,
    );
    const page = publicWorkflowStepPage(
      records,
      (record) => ({ id: record.sk, output: "x".repeat(80) }),
      "upstream-cursor",
      250,
    );

    expect(page.items).toHaveLength(1);
    expect(JSON.parse(Buffer.from(page.nextCursor!, "base64url").toString("utf8"))).toEqual({
      pk: records[0]!.pk,
      sk: records[0]!.sk,
    });
  });
});
