import {
  key,
  type DynamoDatabaseService,
  type Ulid,
  runtimeApiPersistence,
} from "@deployments-ai/db";
import { RuntimeApiError } from "./runtime-api-error.ts";

const MAX_DYNAMODB_PARTITION_KEY_BYTES = 2_048;
const MAX_DYNAMODB_SORT_KEY_BYTES = 1_024;

export function environmentRecordCursor(record: Readonly<Record<string, unknown>>) {
  const value = {
    gsi2pk: record.gsi2pk,
    gsi2sk: record.gsi2sk,
    pk: record.pk,
    sk: record.sk,
  };
  if (Object.values(value).some((entry) => typeof entry !== "string" || !entry)) {
    throw new RuntimeApiError(
      500,
      "invalid_pagination_record",
      "Environment record is missing its pagination keys.",
    );
  }
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export async function listEnvironmentRecords(
  database: DynamoDatabaseService,
  table: "control" | "execution",
  environmentId: Ulid,
  itemType: string,
  options: { readonly cursor?: string; readonly limit?: number; readonly status?: string } = {},
) {
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new RuntimeApiError(400, "invalid_limit", "limit must be an integer from 1 to 100.");
  }
  let exclusiveStartKey: Readonly<Record<string, unknown>> | undefined;
  if (options.cursor !== undefined) {
    if (!options.cursor || options.cursor.length > 4_096) {
      throw new RuntimeApiError(400, "invalid_cursor", "cursor is invalid.");
    }
    try {
      const parsed = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      const values = parsed as Readonly<Record<string, unknown>>;
      if (Object.keys(values).toSorted().join(",") !== "gsi2pk,gsi2sk,pk,sk") {
        throw new Error();
      }
      for (const name of ["pk", "sk", "gsi2pk", "gsi2sk"] as const) {
        const value = values[name];
        const maximumBytes = name.endsWith("pk")
          ? MAX_DYNAMODB_PARTITION_KEY_BYTES
          : MAX_DYNAMODB_SORT_KEY_BYTES;
        if (
          typeof value !== "string" ||
          !value ||
          new TextEncoder().encode(value).byteLength > maximumBytes
        ) {
          throw new Error();
        }
      }
      const gsi2pk = values.gsi2pk as string;
      const gsi2sk = values.gsi2sk as string;
      const prefix = `${itemType.toUpperCase()}#${options.status ? `${options.status}#` : ""}`;
      if (gsi2pk !== key("ENV", environmentId) || !gsi2sk.startsWith(prefix)) {
        throw new Error();
      }
      exclusiveStartKey = parsed as Readonly<Record<string, unknown>>;
    } catch {
      throw new RuntimeApiError(400, "invalid_cursor", "cursor is invalid.");
    }
  }
  const result = await runtimeApiPersistence.find(database, table, {
    ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
    ExpressionAttributeNames: { "#pk": "gsi2pk", "#sk": "gsi2sk" },
    ExpressionAttributeValues: {
      ":pk": key("ENV", environmentId),
      ":prefix": `${itemType.toUpperCase()}#${options.status ? `${options.status}#` : ""}`,
    },
    IndexName: "gsi2",
    KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
    Limit: limit,
    ScanIndexForward: false,
  });
  return {
    items: result.items.filter((record) => record.itemType === itemType),
    ...(result.lastEvaluatedKey
      ? {
          nextCursor: environmentRecordCursor(result.lastEvaluatedKey),
        }
      : {}),
  };
}
