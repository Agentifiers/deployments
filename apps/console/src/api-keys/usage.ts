import type { OperationalRecordResponse } from "@deployments-ai/api-contract";
import {
  DAY_MS,
  METRIC_RANGES,
  oneOf,
  RANGE_DAYS,
  type MetricRange,
} from "../observability/range.ts";

export const KEY_OUTCOMES = ["allowed", "denied", "error"] as const;
export type KeyOutcome = (typeof KEY_OUTCOMES)[number];

export const RECENT_CALLS = 50;

export interface KeyCall {
  readonly createdAt: string;
  readonly failureReason?: string;
  readonly outcome: KeyOutcome;
  readonly requestMethod: string;
  readonly requestPath: string;
}

export interface KeyUsage {
  readonly complete: boolean;
  readonly counts: Readonly<Record<KeyOutcome, number>>;
  readonly recent: readonly KeyCall[];
  readonly unreadable: number;
}

export type OperationalRecord = typeof OperationalRecordResponse.Type;

export interface KeyUsageSearch {
  readonly window: MetricRange;
}

export function parseKeyUsageSearch(search: Readonly<Record<string, unknown>>): KeyUsageSearch {
  return { window: oneOf(METRIC_RANGES, search.window) ?? "24h" };
}

export function usageWindowBounds(window: MetricRange, now: Date) {
  return {
    since: new Date(now.getTime() - RANGE_DAYS[window] * DAY_MS).toISOString(),
    until: now.toISOString(),
  };
}

export function parseKeyCall(record: OperationalRecord): KeyCall | undefined {
  if (record.type !== "api-credential-usage") return undefined;
  const { createdAt, failureReason, outcome, requestMethod, requestPath } = record.data;
  const known = oneOf(KEY_OUTCOMES, outcome);
  if (
    known === undefined ||
    typeof createdAt !== "string" ||
    typeof requestMethod !== "string" ||
    typeof requestPath !== "string"
  ) {
    return undefined;
  }
  return {
    createdAt,
    ...(typeof failureReason === "string" ? { failureReason } : {}),
    outcome: known,
    requestMethod,
    requestPath,
  };
}

export function summarizeKeyUsage(
  records: readonly OperationalRecord[],
  complete: boolean,
): KeyUsage {
  const calls = records.flatMap((record) => parseKeyCall(record) ?? []);
  const counts: Record<KeyOutcome, number> = { allowed: 0, denied: 0, error: 0 };
  for (const call of calls) counts[call.outcome] += 1;
  return {
    complete,
    counts,
    recent: calls
      .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, RECENT_CALLS),
    unreadable: records.length - calls.length,
  };
}
