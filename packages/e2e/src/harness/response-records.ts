import { expect } from "@effect/vitest";
import type { HttpResult } from "./http-client.ts";
import { record } from "./live-agent.ts";

type JsonRecord = Record<string, unknown>;

/** Asserts the response status, then returns its body as a JSON object. */
export function json(response: HttpResult, status: number, label: string): JsonRecord {
  expect(response.status, `${label}: ${response.body}`).toBe(status);
  return record(response.json, label);
}

export function records(value: unknown, label: string): JsonRecord[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} was not an array.`);
  return value.map((entry, index) => record(entry, `${label}[${index}]`));
}

export function version(value: JsonRecord, label: string): number {
  if (!Number.isSafeInteger(value.version)) throw new TypeError(`${label}.version was invalid.`);
  return value.version as number;
}
