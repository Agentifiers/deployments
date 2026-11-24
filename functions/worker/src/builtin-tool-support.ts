import type { RuntimeToolExecutionResult } from "@deployments-ai/agent-runtime";
import {
  Ulid,
  type DynamoDatabaseService,
  type PlatformRecord,
  type Ulid as UlidValue,
  workerPersistence,
} from "@deployments-ai/db";
import { Schema } from "effect";

type QueryInput = Parameters<DynamoDatabaseService["queryRecords"]>[1];
type QueryTable = Parameters<DynamoDatabaseService["queryRecords"]>[0];

/** Exhaust a shared index or fail explicitly at a defensive scan bound. */
export async function queryRecordPages(options: {
  readonly database: DynamoDatabaseService;
  readonly input: QueryInput;
  readonly maximumPages?: number;
  readonly maximumRecords?: number;
  readonly signal?: AbortSignal;
  readonly table: QueryTable;
}): Promise<readonly PlatformRecord[]> {
  const items: PlatformRecord[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  const maximumPages = options.maximumPages ?? 1_000;
  const maximumRecords = options.maximumRecords ?? 100_000;
  /* eslint-disable no-await-in-loop -- DynamoDB pagination is cursor-ordered. */
  for (let pageIndex = 0; pageIndex < maximumPages; pageIndex += 1) {
    const page = await workerPersistence.find(
      options.database,
      options.table,
      {
        ...options.input,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      },
      options.signal,
    );
    items.push(...page.items);
    if (items.length > maximumRecords) {
      throw new RangeError(`DynamoDB query exceeded the ${maximumRecords} record scan limit.`);
    }
    exclusiveStartKey = page.lastEvaluatedKey;
    if (!exclusiveStartKey) break;
  }
  if (exclusiveStartKey) {
    throw new RangeError(`DynamoDB query exceeded the ${maximumPages} page scan limit.`);
  }
  return items;
}

export function toolInput(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Tool input must be an object.");
  }
  return value as Readonly<Record<string, unknown>>;
}

export function logicallyExpired(expiresAt: string | undefined, now = Date.now()) {
  return expiresAt !== undefined && Date.parse(expiresAt) <= now;
}

export function requiredString(
  input: Readonly<Record<string, unknown>>,
  name: string,
  maximum = 40_000,
): string {
  const value = input[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  const normalized = value.trim();
  if (normalized.length > maximum) throw new TypeError(`${name} is too long.`);
  return normalized;
}

export function optionalString(
  input: Readonly<Record<string, unknown>>,
  name: string,
  maximum = 40_000,
): string | undefined {
  if (input[name] === undefined) return undefined;
  return requiredString(input, name, maximum);
}

export function optionalInteger(
  input: Readonly<Record<string, unknown>>,
  name: string,
  options: { readonly maximum: number; readonly minimum: number },
): number | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < options.minimum ||
    Number(value) > options.maximum
  ) {
    throw new TypeError(
      `${name} must be an integer from ${options.minimum} to ${options.maximum}.`,
    );
  }
  return Number(value);
}

export function ulid(value: unknown, name: string): UlidValue {
  try {
    return Schema.decodeUnknownSync(Ulid)(value);
  } catch (cause) {
    throw new TypeError(`${name} must be a canonical ULID.`, { cause });
  }
}

export function jsonToolResult(options: {
  readonly fileName: string;
  readonly label: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly summary: string;
  readonly value: unknown;
  readonly visibility?: "organization" | "private";
}): RuntimeToolExecutionResult {
  return {
    artifacts: [
      {
        content: `${JSON.stringify(options.value, null, 2)}\n`,
        contentType: "application/json",
        fileName: options.fileName,
        label: options.label,
        ...(options.metadata ? { metadata: options.metadata } : {}),
        type: "report",
        visibility: options.visibility ?? "private",
      },
    ],
    outputSummary: options.summary,
    status: "completed",
  };
}

export function textToolResult(options: {
  readonly content: string;
  readonly contentType?: string;
  readonly fileName: string;
  readonly label: string;
  readonly summary: string;
  readonly type?: string;
  readonly visibility?: "organization" | "private";
}): RuntimeToolExecutionResult {
  return {
    artifacts: [
      {
        content: options.content,
        contentType: options.contentType ?? "text/plain; charset=utf-8",
        fileName: options.fileName,
        label: options.label,
        type: options.type ?? "report",
        visibility: options.visibility ?? "private",
      },
    ],
    outputSummary: options.summary,
    status: "completed",
  };
}
