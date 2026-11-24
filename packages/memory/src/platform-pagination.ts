import {
  key,
  type DynamoDatabaseService,
  type PlatformRecord,
  type Ulid,
  memoryPersistence,
} from "@deployments-ai/db";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import * as Types from "./platform-types.ts";

const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
export const MAX_FILTERED_PAGE_QUERIES = 256;

const localPageCursorKey = randomBytes(32);

export const localPageCursorCodec: Types.MemoryPageCursorCodec = {
  open: async (ciphertext) => {
    try {
      const bytes = Buffer.from(ciphertext, "base64url");
      if (bytes.byteLength < 29) throw new Error("Invalid encrypted cursor.");
      const decipher = createDecipheriv("aes-256-gcm", localPageCursorKey, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(
        "utf8",
      );
    } catch (cause) {
      throw new Types.InvalidMemoryPageCursorError("Invalid encrypted cursor.", { cause });
    }
  },
  seal: async (plaintext) => {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", localPageCursorKey, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64url");
  },
};

export function boundedLimit(value: number | undefined) {
  return Math.max(1, Math.min(Math.trunc(value ?? DEFAULT_LIMIT), MAX_LIMIT));
}

function encodePageCursor(itemType: PlatformRecord["itemType"], keyValue: Record<string, unknown>) {
  return Buffer.from(JSON.stringify({ itemType, key: keyValue, version: 1 })).toString("base64url");
}

function decodePageCursor(cursor: string | undefined, itemType: PlatformRecord["itemType"]) {
  if (!cursor) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError();
    const value = parsed as Record<string, unknown>;
    if (
      value.version !== 1 ||
      value.itemType !== itemType ||
      !value.key ||
      typeof value.key !== "object" ||
      Array.isArray(value.key)
    ) {
      throw new TypeError();
    }
    const cursorKey = value.key as Record<string, unknown>;
    if (
      ["pk", "sk", "gsi2pk", "gsi2sk"].some(
        (field) => typeof cursorKey[field] !== "string" || cursorKey[field] === "",
      )
    ) {
      throw new TypeError();
    }
    return cursorKey;
  } catch {
    throw new Types.MemoryPlatformError(
      400,
      "invalid_cursor",
      "Memory pagination cursor is invalid.",
    );
  }
}

async function decodeRecordPageCursor(
  cursor: string | undefined,
  itemType: PlatformRecord["itemType"],
  codec: Types.MemoryPageCursorCodec,
) {
  if (!cursor) return undefined;
  let value: Record<string, unknown>;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError();
    value = parsed as Record<string, unknown>;
    if (value.version === 1) return decodePageCursor(cursor, itemType);
    if (value.version !== 2 || value.itemType !== itemType || typeof value.token !== "string") {
      throw new TypeError();
    }
  } catch {
    throw new Types.MemoryPlatformError(
      400,
      "invalid_cursor",
      "Memory pagination cursor is invalid.",
    );
  }
  let plaintext: string;
  try {
    plaintext = await codec.open(value.token as string);
  } catch (cause) {
    if (cause instanceof Types.InvalidMemoryPageCursorError) {
      throw new Types.MemoryPlatformError(
        400,
        "invalid_cursor",
        "Memory pagination cursor is invalid.",
      );
    }
    throw new Types.MemoryPlatformError(
      503,
      "cursor_unavailable",
      "Memory pagination cursor could not be decoded.",
      { cause },
    );
  }
  return decodePageCursor(plaintext, itemType);
}

async function encodePrivatePageCursor(
  itemType: PlatformRecord["itemType"],
  keyValue: Record<string, unknown>,
  codec: Types.MemoryPageCursorCodec,
) {
  let token: string;
  try {
    token = await codec.seal(encodePageCursor(itemType, keyValue));
  } catch (cause) {
    throw new Types.MemoryPlatformError(
      503,
      "cursor_unavailable",
      "Memory pagination cursor could not be encoded.",
      { cause },
    );
  }
  return Buffer.from(JSON.stringify({ itemType, token, version: 2 })).toString("base64url");
}

function pageCursorKey(record: PlatformRecord) {
  const cursorKey = {
    gsi2pk: record.gsi2pk,
    gsi2sk: record.gsi2sk,
    pk: record.pk,
    sk: record.sk,
  };
  if (Object.values(cursorKey).some((value) => typeof value !== "string" || value === "")) {
    throw new Types.MemoryPlatformError(
      500,
      "invalid_record_key",
      "Memory record cannot be used for pagination.",
    );
  }
  return cursorKey as Record<"gsi2pk" | "gsi2sk" | "pk" | "sk", string>;
}

export async function queryEnvironmentRecordPage<T extends PlatformRecord>(args: {
  readonly cursor?: string;
  readonly cursorCodec: Types.MemoryPageCursorCodec;
  readonly database: DynamoDatabaseService;
  readonly environmentId: Ulid;
  readonly filter: (record: T) => boolean;
  readonly itemType: T["itemType"];
  readonly limit?: number;
  readonly status?: string;
  readonly table: "control" | "execution";
}) {
  const limit = boundedLimit(args.limit);
  const prefix = `${key(String(args.itemType).toUpperCase(), ...(args.status ? [args.status] : []))}#`;
  const items: T[] = [];
  let exclusiveStartKey = await decodeRecordPageCursor(
    args.cursor,
    args.itemType,
    args.cursorCodec,
  );
  let queryCount = 0;
  do {
    queryCount += 1;
    const result = await memoryPersistence.find(args.database, args.table, {
      ExpressionAttributeValues: {
        ":pk": key("ENV", args.environmentId),
        ":prefix": prefix,
      },
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      IndexName: "gsi2",
      KeyConditionExpression: "gsi2pk = :pk AND begins_with(gsi2sk, :prefix)",
      Limit: limit - items.length,
      ScanIndexForward: false,
    });
    items.push(
      ...result.items
        .filter((value): value is T => value.itemType === args.itemType)
        .filter(args.filter),
    );
    exclusiveStartKey = result.lastEvaluatedKey;
  } while (exclusiveStartKey && items.length < limit && queryCount < MAX_FILTERED_PAGE_QUERIES);
  const nextCursor = exclusiveStartKey
    ? items.length >= limit
      ? encodePageCursor(args.itemType, pageCursorKey(items.at(-1)!))
      : await encodePrivatePageCursor(args.itemType, exclusiveStartKey, args.cursorCodec)
    : undefined;
  return {
    items,
    ...(nextCursor ? { nextCursor } : {}),
  };
}
