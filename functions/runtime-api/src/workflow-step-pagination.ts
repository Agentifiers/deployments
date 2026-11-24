import {
  key,
  type DynamoDatabaseService,
  type Ulid,
  type WorkflowStepAttemptRecordValue,
  runtimeApiPersistence,
} from "@deployments-ai/db";
import { RuntimeApiError } from "./runtime-api-error.ts";

const fields = ["pk", "sk"] as const;
const MAX_WORKFLOW_STEP_LIST_RESPONSE_BYTES = 4 * 1024 * 1024;
const WORKFLOW_STEP_CURSOR_RESERVE = "x".repeat(8 * 1024);

function encodeCursor(record: Pick<WorkflowStepAttemptRecordValue, "pk" | "sk">) {
  return Buffer.from(JSON.stringify({ pk: record.pk, sk: record.sk }), "utf8").toString(
    "base64url",
  );
}

export function publicWorkflowStepPage<T>(
  records: readonly WorkflowStepAttemptRecordValue[],
  project: (record: WorkflowStepAttemptRecordValue) => T,
  upstreamNextCursor?: string,
  maximumBytes = MAX_WORKFLOW_STEP_LIST_RESPONSE_BYTES,
) {
  const items: T[] = [];
  for (const [index, record] of records.entries()) {
    const projected = project(record);
    const candidate = [...items, projected];
    const encodedBytes = new TextEncoder().encode(
      JSON.stringify({
        items: candidate,
        nextCursor: upstreamNextCursor ?? WORKFLOW_STEP_CURSOR_RESERVE,
      }),
    ).byteLength;
    if (encodedBytes > maximumBytes) {
      if (items.length === 0) {
        throw new RuntimeApiError(
          413,
          "workflow_step_page_too_large",
          "A single workflow step attempt exceeds the public response limit.",
        );
      }
      return { items, nextCursor: encodeCursor(records[index - 1]!) };
    }
    items.push(projected);
  }
  return { items, ...(upstreamNextCursor ? { nextCursor: upstreamNextCursor } : {}) };
}

function decodeCursor(value: string | undefined, partition: string) {
  if (value === undefined) return undefined;
  if (!value || value.length > 4_096) {
    throw new RuntimeApiError(400, "invalid_cursor", "Workflow step cursor is invalid.");
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    const record = parsed as Readonly<Record<string, unknown>>;
    if (Object.keys(record).toSorted().join(",") !== fields.join(",")) throw new Error();
    if (
      record.pk !== partition ||
      typeof record.sk !== "string" ||
      !record.sk.startsWith("WORKFLOW-STEP-ATTEMPT#") ||
      new TextEncoder().encode(record.sk).byteLength > 1_024
    ) {
      throw new Error();
    }
    return record as Readonly<Record<(typeof fields)[number], string>>;
  } catch {
    throw new RuntimeApiError(400, "invalid_cursor", "Workflow step cursor is invalid.");
  }
}

export async function listWorkflowStepAttempts(
  database: DynamoDatabaseService,
  organizationId: Ulid,
  executionId: Ulid,
  options: { readonly cursor?: string; readonly limit?: number } = {},
) {
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new RuntimeApiError(400, "invalid_limit", "limit must be an integer from 1 to 100.");
  }
  const partition = key("ORG", organizationId, "WORKFLOW-EXECUTION", executionId);
  const page = await runtimeApiPersistence.find(database, "execution", {
    ...(options.cursor ? { ExclusiveStartKey: decodeCursor(options.cursor, partition) } : {}),
    ConsistentRead: true,
    ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
    ExpressionAttributeValues: {
      ":pk": partition,
      ":prefix": "WORKFLOW-STEP-ATTEMPT#",
    },
    KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
    Limit: limit,
    ScanIndexForward: true,
  });
  return {
    items: page.items.filter((record) => record.itemType === "workflow-step-attempt"),
    ...(page.lastEvaluatedKey
      ? {
          nextCursor: Buffer.from(JSON.stringify(page.lastEvaluatedKey), "utf8").toString(
            "base64url",
          ),
        }
      : {}),
  };
}
