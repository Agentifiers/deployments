import { AutomationError } from "./errors.ts";

export interface HeartbeatActiveWindow {
  readonly daysOfWeek?: readonly number[];
  readonly endMinuteOfDay: number;
  readonly startMinuteOfDay: number;
}

export function validateHeartbeatActiveWindow(
  value: Readonly<Record<string, unknown>> | undefined,
): HeartbeatActiveWindow | undefined {
  if (!value) return undefined;
  const start = value.startMinuteOfDay;
  const end = value.endMinuteOfDay;
  const days = value.daysOfWeek;
  const normalizedDays = Array.isArray(days)
    ? [...new Set(days.map(Number))].toSorted((left, right) => left - right)
    : undefined;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    Number(start) < 0 ||
    Number(start) > 1439 ||
    Number(end) < 0 ||
    Number(end) > 1440 ||
    (days !== undefined &&
      (!Array.isArray(days) ||
        days.length > 7 ||
        normalizedDays?.length !== days.length ||
        days.some((day) => !Number.isInteger(day) || Number(day) < 0 || Number(day) > 6)))
  ) {
    throw new AutomationError("invalid_heartbeat", "Heartbeat active window is invalid.");
  }
  return {
    ...(normalizedDays ? { daysOfWeek: normalizedDays } : {}),
    endMinuteOfDay: Number(end),
    startMinuteOfDay: Number(start),
  };
}
