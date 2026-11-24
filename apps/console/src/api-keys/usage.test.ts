import type { JsonValue } from "@deployments-ai/api-contract/primitives";
import { describe, expect, test } from "bun:test";
import {
  parseKeyCall,
  parseKeyUsageSearch,
  summarizeKeyUsage,
  usageWindowBounds,
  type OperationalRecord,
} from "./usage.ts";

function call(createdAt: string, outcome: string, extra: Record<string, JsonValue> = {}) {
  return {
    data: {
      apiCredentialId: "01K0000000000000000000K001",
      createdAt,
      outcome,
      requestMethod: "POST",
      requestPath: "/v1/threads",
      ...extra,
    },
    type: "api-credential-usage",
  } satisfies OperationalRecord;
}

describe("parseKeyCall", () => {
  test("keeps the request, outcome, and a string failure reason", () => {
    expect(
      parseKeyCall(
        call("2026-10-05T11:00:00.000Z", "denied", { failureReason: "insufficient_scope" }),
      ),
    ).toEqual({
      createdAt: "2026-10-05T11:00:00.000Z",
      failureReason: "insufficient_scope",
      outcome: "denied",
      requestMethod: "POST",
      requestPath: "/v1/threads",
    });
    expect(parseKeyCall(call("2026-10-05T11:00:00.000Z", "allowed", { failureReason: 7 }))).toEqual(
      {
        createdAt: "2026-10-05T11:00:00.000Z",
        outcome: "allowed",
        requestMethod: "POST",
        requestPath: "/v1/threads",
      },
    );
  });

  test("rejects other record types, unknown outcomes, and missing or mistyped fields", () => {
    expect(parseKeyCall({ ...call("2026-10-05T11:00:00.000Z", "allowed"), type: "usage" })).toBe(
      undefined,
    );
    expect(parseKeyCall(call("2026-10-05T11:00:00.000Z", "blocked"))).toBe(undefined);
    expect(parseKeyCall(call("2026-10-05T11:00:00.000Z", "allowed", { requestPath: null }))).toBe(
      undefined,
    );
    expect(parseKeyCall(call("2026-10-05T11:00:00.000Z", "error", { createdAt: 1 }))).toBe(
      undefined,
    );
  });
});

describe("summarizeKeyUsage", () => {
  test("counts outcomes, lists the newest calls first, and counts unreadable records", () => {
    const usage = summarizeKeyUsage(
      [
        call("2026-10-05T09:00:00.000Z", "allowed"),
        call("2026-10-05T11:00:00.000Z", "error", { failureReason: "timeout" }),
        call("2026-10-05T10:00:00.000Z", "denied"),
        call("2026-10-05T08:00:00.000Z", "allowed"),
        call("2026-10-05T07:00:00.000Z", "blocked"),
        { data: {}, type: "api-credential-usage" },
      ],
      false,
    );
    expect(usage.counts).toEqual({ allowed: 2, denied: 1, error: 1 });
    expect(usage.complete).toBe(false);
    expect(usage.unreadable).toBe(2);
    expect(usage.recent.map((entry) => `${entry.createdAt} ${entry.outcome}`)).toEqual([
      "2026-10-05T11:00:00.000Z error",
      "2026-10-05T10:00:00.000Z denied",
      "2026-10-05T09:00:00.000Z allowed",
      "2026-10-05T08:00:00.000Z allowed",
    ]);
  });

  test("keeps only the 50 newest calls but counts every one", () => {
    const records = Array.from({ length: 60 }, (_, minute) =>
      call(`2026-10-05T10:${String(minute).padStart(2, "0")}:00.000Z`, "allowed"),
    );
    const usage = summarizeKeyUsage(records, true);
    expect(usage.counts).toEqual({ allowed: 60, denied: 0, error: 0 });
    expect(usage.recent).toHaveLength(50);
    expect(usage.recent[0]?.createdAt).toBe("2026-10-05T10:59:00.000Z");
    expect(usage.recent[49]?.createdAt).toBe("2026-10-05T10:10:00.000Z");
  });
});

test("usage windows end now and reach back 24 hours, 7 days, or 30 days", () => {
  const now = new Date("2026-10-05T12:34:56.789Z");
  expect(usageWindowBounds("24h", now)).toEqual({
    since: "2026-10-04T12:34:56.789Z",
    until: "2026-10-05T12:34:56.789Z",
  });
  expect(usageWindowBounds("7d", now).since).toBe("2026-09-28T12:34:56.789Z");
  expect(usageWindowBounds("30d", now).since).toBe("2026-09-05T12:34:56.789Z");
});

test("the key page's window defaults to 24 hours", () => {
  expect(parseKeyUsageSearch({ window: "7d" })).toEqual({ window: "7d" });
  expect(parseKeyUsageSearch({ window: "1y" })).toEqual({ window: "24h" });
  expect(parseKeyUsageSearch({})).toEqual({ window: "24h" });
});
