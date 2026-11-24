import {
  key,
  type DynamoDatabaseService,
  type PlatformRecord,
  runtimeApiPersistence,
} from "@deployments-ai/db";
import { RuntimeApiError } from "./runtime-api-error.ts";

const encoder = new TextEncoder();
const cursorFields = ["gsi1pk", "gsi1sk", "pk", "sk"] as const;

function decodeCursor(value: string | undefined, expectedPartition: string) {
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    const record = parsed as Readonly<Record<string, unknown>>;
    if (Object.keys(record).toSorted().join("\0") !== [...cursorFields].toSorted().join("\0")) {
      throw new Error();
    }
    for (const field of cursorFields) {
      const fieldValue = record[field];
      const maximumBytes = field.endsWith("pk") ? 2_048 : 1_024;
      if (
        typeof fieldValue !== "string" ||
        !fieldValue ||
        encoder.encode(fieldValue).byteLength > maximumBytes
      ) {
        throw new Error();
      }
    }
    if (record.gsi1pk !== expectedPartition) throw new Error();
    return record as Readonly<Record<(typeof cursorFields)[number], string>>;
  } catch {
    throw new RuntimeApiError(400, "invalid_cursor", "History cursor is invalid.");
  }
}

function encodeCursor(value: Readonly<Record<string, unknown>> | undefined) {
  return value ? Buffer.from(JSON.stringify(value), "utf8").toString("base64url") : undefined;
}

export async function listAutomationHistory(
  database: DynamoDatabaseService,
  input: {
    readonly cursor?: string;
    readonly id: string;
    readonly limit?: number;
    readonly organizationId: string;
    readonly type: "heartbeat" | "schedule";
  },
) {
  const limit = input.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new RuntimeApiError(400, "invalid_limit", "limit must be an integer from 1 to 100.");
  }
  const historyPartition = key(
    "ORG",
    input.organizationId,
    input.type.toUpperCase(),
    input.id,
    "FIRES",
  );
  const page = await runtimeApiPersistence.find(database, "execution", {
    ...(input.cursor ? { ExclusiveStartKey: decodeCursor(input.cursor, historyPartition) } : {}),
    ExpressionAttributeNames: { "#pk": "gsi1pk" },
    ExpressionAttributeValues: {
      ":pk": historyPartition,
    },
    IndexName: "gsi1",
    KeyConditionExpression: "#pk = :pk",
    Limit: limit,
    ScanIndexForward: false,
  });
  return {
    items: page.items.filter(
      (record): record is PlatformRecord =>
        record.itemType === (input.type === "schedule" ? "schedule-fire" : "heartbeat-run"),
    ),
    nextCursor: encodeCursor(page.lastEvaluatedKey),
  };
}
