import { BrainErasureResponse } from "@deployments-ai/api-contract/brains";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { erasureInFlight, erasurePhase, erasureView, parseEraseSearch } from "./erasure.ts";

const decodeReceipt = Schema.decodeUnknownSync(BrainErasureResponse);

const receipt = (patch: Readonly<Record<string, unknown>>) =>
  erasureView(
    decodeReceipt({
      brainId: "01K0000000000000000000000A",
      contentVerificationCount: 0,
      createdAt: "2026-10-09T12:00:00.000Z",
      erasureGeneration: 4,
      id: "01K0000000000000000000000B",
      organizationId: "01K0000000000000000000000C",
      status: "pending",
      updatedAt: "2026-10-09T12:00:00.000Z",
      version: 0,
      ...patch,
    }),
  );

describe("parseEraseSearch", () => {
  test("keeps a non-negative integer version and overrides anything else with undefined", () => {
    const parsed = [
      { version: 3 },
      { version: 0 },
      { version: -1 },
      { version: 2.5 },
      { version: "abc" },
      {},
    ].map(parseEraseSearch);
    expect(parsed.every((search) => Object.hasOwn(search, "version"))).toBe(true);
    expect(parsed).toStrictEqual([
      { version: 3 },
      { version: 0 },
      { version: undefined },
      { version: undefined },
      { version: undefined },
      { version: undefined },
    ]);
  });
});

describe("erasureView", () => {
  test("drops the untyped search receipt and keeps only whether it was recorded", () => {
    const view = receipt({ searchReceipt: { brainSearch: { deleted: 12 } }, status: "completed" });
    expect(Object.hasOwn(view, "searchReceipt")).toBe(false);
    expect(view.searchAbsenceRecorded).toBe(true);
  });
});

describe("erasurePhase", () => {
  test("reads each receipt status as the phase the page shows", () => {
    expect(
      [
        receipt({ status: "pending" }),
        receipt({ startedAt: "2026-10-09T12:01:00.000Z", status: "running" }),
        receipt({
          completedAt: "2026-10-09T12:20:00.000Z",
          contentVerificationCount: 2,
          recordsDeleted: 41,
          searchReceipt: { brainSearch: { deleted: 12 } },
          status: "completed",
        }),
        receipt({ contentVerificationCount: 2, status: "completed" }),
        receipt({ error: "S3 version purge failed", status: "failed" }),
      ].map(erasurePhase),
    ).toEqual([
      { kind: "queued" },
      { kind: "running", startedAt: "2026-10-09T12:01:00.000Z" },
      {
        completedAt: "2026-10-09T12:20:00.000Z",
        contentChecks: 2,
        kind: "erased",
        recordsDeleted: 41,
        searchAbsenceRecorded: true,
      },
      { contentChecks: 2, kind: "erased", searchAbsenceRecorded: false },
      { error: "S3 version purge failed", kind: "failed" },
    ]);
  });
});

describe("erasureInFlight", () => {
  test("the receipt page polls while pending or running and stops otherwise", () => {
    expect(
      [
        undefined,
        receipt({ status: "pending" }),
        receipt({ status: "running" }),
        receipt({ status: "completed" }),
        receipt({ status: "failed" }),
      ].map(erasureInFlight),
    ).toEqual([false, true, true, false, false]);
  });
});
