import { describe, expect, test } from "bun:test";
import {
  localDay,
  localDayBound,
  parseApprovalFilters,
  parseRunFeedFilters,
  parseRunFilters,
  parseRuntimeId,
  parseThreadSearch,
} from "./filters.ts";

const DEPLOYMENT = "01M3SMDX3JA4BCHC1FBXZYFEZD";
const RELEASE = "01M3SME0RMA6Z4TT11ZXAXCHPA";
const THREAD = "01M3SM00000000000000THREAD";

describe("parseRunFilters", () => {
  test("keeps a known status and purpose", () => {
    expect(parseRunFilters({ executionPurpose: "preview", status: "waiting-for-tool" })).toEqual({
      executionPurpose: "preview",
      status: "waiting-for-tool",
    });
  });

  test("drops unknown values so a stale link still lists runs", () => {
    expect(parseRunFilters({ executionPurpose: "batch", status: "paused" })).toEqual({});
  });
});

describe("parseRunFeedFilters", () => {
  test("keeps valid IDs and canonical instants", () => {
    expect(
      parseRunFeedFilters({
        agentDeploymentId: DEPLOYMENT,
        agentReleaseId: RELEASE,
        createdAfter: "2026-10-01T00:00:00.000Z",
        createdBefore: "2026-10-05T23:59:59.999Z",
        executionPurpose: "customer",
        status: "failed",
        threadId: THREAD,
      }),
    ).toEqual({
      agentDeploymentId: DEPLOYMENT,
      agentReleaseId: RELEASE,
      createdAfter: "2026-10-01T00:00:00.000Z",
      createdBefore: "2026-10-05T23:59:59.999Z",
      executionPurpose: "customer",
      status: "failed",
      threadId: THREAD,
    });
  });

  test("drops malformed IDs and timestamps the API would reject", () => {
    expect(
      parseRunFeedFilters({
        agentDeploymentId: DEPLOYMENT.toLowerCase(),
        agentReleaseId: `${RELEASE}X`,
        createdAfter: "2026-10-01T00:00:00Z",
        createdBefore: "2026-02-30T00:00:00.000Z",
        threadId: 42,
      }),
    ).toEqual({});
  });
});

describe("parseApprovalFilters", () => {
  test("pending is the default, so it never appears in the URL", () => {
    expect(parseApprovalFilters({ status: "pending" })).toEqual({});
    expect(parseApprovalFilters({})).toEqual({});
  });

  test("keeps the other tabs and drops unknown ones", () => {
    expect(parseApprovalFilters({ status: "expired" })).toEqual({ status: "expired" });
    expect(parseApprovalFilters({ status: "all" })).toEqual({ status: "all" });
    expect(parseApprovalFilters({ status: "denied" })).toEqual({});
  });
});

describe("parseThreadSearch", () => {
  test("keeps the run a link opened the thread for", () => {
    expect(parseThreadSearch({ run: DEPLOYMENT })).toEqual({ run: DEPLOYMENT });
  });

  test("drops a run that is not an ID", () => {
    expect(parseThreadSearch({ run: "latest" })).toEqual({});
    expect(parseThreadSearch({})).toEqual({});
  });
});

describe("parseRuntimeId", () => {
  test("forgives surrounding space and lowercase", () => {
    expect(parseRuntimeId(`  ${THREAD.toLowerCase()}\n`)).toBe(THREAD);
  });

  test("rejects text that is not a ULID", () => {
    expect(parseRuntimeId("run_123")).toBeUndefined();
    expect(parseRuntimeId(`${THREAD}0`)).toBeUndefined();
    expect(parseRuntimeId("")).toBeUndefined();
  });
});

describe("local calendar days", () => {
  test("a day's bounds are canonical instants that map back to the same local day", () => {
    const start = localDayBound("2026-07-15", "start");
    const end = localDayBound("2026-07-15", "end");
    expect(start).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
    expect(localDay(start ?? "")).toBe("2026-07-15");
    expect(localDay(end ?? "")).toBe("2026-07-15");
    expect(Date.parse(end ?? "") - Date.parse(start ?? "")).toBe(86_399_999);
  });

  test("rejects days that do not exist and other text", () => {
    expect(localDayBound("2026-02-30", "start")).toBeUndefined();
    expect(localDayBound("2026-7-15", "end")).toBeUndefined();
    expect(localDayBound("", "start")).toBeUndefined();
  });
});
