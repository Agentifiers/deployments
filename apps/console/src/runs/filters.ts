import { oneOf } from "../observability/range.ts";
import { EXECUTION_PURPOSES } from "../observability/trace-filters.ts";

export const RUN_STATUSES = [
  "canceled",
  "completed",
  "failed",
  "queued",
  "running",
  "waiting-for-approval",
  "waiting-for-tool",
] as const;

export const APPROVAL_TABS = ["pending", "approved", "rejected", "expired", "all"] as const;
export type ApprovalTab = (typeof APPROVAL_TABS)[number];

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const CANONICAL_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const CALENDAR_DAY = /^(\d{4})-(\d{2})-(\d{2})$/u;

export interface RunFilters {
  readonly executionPurpose?: (typeof EXECUTION_PURPOSES)[number];
  readonly status?: (typeof RUN_STATUSES)[number];
}

export interface RunFeedFilters extends RunFilters {
  readonly agentDeploymentId?: string;
  readonly agentReleaseId?: string;
  readonly createdAfter?: string;
  readonly createdBefore?: string;
  readonly threadId?: string;
}

export interface ApprovalFilters {
  readonly status?: Exclude<ApprovalTab, "pending">;
}

export interface ThreadSearch {
  readonly run?: string;
}

function ulid(value: unknown) {
  return typeof value === "string" && ULID.test(value) ? value : undefined;
}

function instant(value: unknown) {
  if (typeof value !== "string" || !CANONICAL_INSTANT.test(value)) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
    ? value
    : undefined;
}

export function parseRunFilters(search: Readonly<Record<string, unknown>>): RunFilters {
  const executionPurpose = oneOf(EXECUTION_PURPOSES, search.executionPurpose);
  const status = oneOf(RUN_STATUSES, search.status);
  return {
    ...(executionPurpose ? { executionPurpose } : {}),
    ...(status ? { status } : {}),
  };
}

export function parseRunFeedFilters(search: Readonly<Record<string, unknown>>): RunFeedFilters {
  const agentDeploymentId = ulid(search.agentDeploymentId);
  const agentReleaseId = ulid(search.agentReleaseId);
  const createdAfter = instant(search.createdAfter);
  const createdBefore = instant(search.createdBefore);
  const threadId = ulid(search.threadId);
  return {
    ...parseRunFilters(search),
    ...(agentDeploymentId ? { agentDeploymentId } : {}),
    ...(agentReleaseId ? { agentReleaseId } : {}),
    ...(createdAfter ? { createdAfter } : {}),
    ...(createdBefore ? { createdBefore } : {}),
    ...(threadId ? { threadId } : {}),
  };
}

export function parseApprovalFilters(search: Readonly<Record<string, unknown>>): ApprovalFilters {
  const status = oneOf(APPROVAL_TABS, search.status);
  return status && status !== "pending" ? { status } : {};
}

export function parseThreadSearch(search: Readonly<Record<string, unknown>>): ThreadSearch {
  const run = ulid(search.run);
  return run ? { run } : {};
}

export function parseRuntimeId(text: string): string | undefined {
  const id = text.trim().toUpperCase();
  return ULID.test(id) ? id : undefined;
}

export function localDayBound(day: string, bound: "end" | "start"): string | undefined {
  const match = CALENDAR_DAY.exec(day);
  if (!match) return undefined;
  const [year, month, date] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  const value =
    bound === "start" ? new Date(year, month, date) : new Date(year, month, date, 23, 59, 59, 999);
  const exists =
    value.getFullYear() === year && value.getMonth() === month && value.getDate() === date;
  return exists ? value.toISOString() : undefined;
}

export function localDay(value: string): string {
  const date = new Date(value);
  return [
    String(date.getFullYear()).padStart(4, "0"),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}
