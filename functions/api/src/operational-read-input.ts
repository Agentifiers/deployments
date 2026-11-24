/** Query validation shared by the operational reads (usage, costs, spend, API keys, audit). */

export class OperationalReadError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OperationalReadError";
  }
}

export function canonicalTimestamp(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new OperationalReadError(400, "invalid_query", `${label} must be a timestamp.`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new OperationalReadError(
      400,
      "invalid_query",
      `${label} must use canonical UTC millisecond precision.`,
    );
  }
  return value;
}

export function pageLimit(value: unknown, maximum: number) {
  if (value === undefined) return Math.min(100, maximum);
  const parsed = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || Number(parsed) < 1 || Number(parsed) > maximum) {
    throw new OperationalReadError(
      400,
      "invalid_limit",
      `limit must be an integer from 1 to ${maximum}.`,
    );
  }
  return Number(parsed);
}
