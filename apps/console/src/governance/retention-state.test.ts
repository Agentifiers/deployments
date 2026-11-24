import {
  AuditRetentionDays,
  OrganizationRetentionPolicyResponse,
  RetentionDays,
  RetentionResource,
} from "@deployments-ai/api-contract/governance";
import { describe, expect, test } from "bun:test";
import { Exit, Schema } from "effect";
import {
  patchApplied,
  planRetention,
  RETENTION_CLASSES,
  rebaseRetentionDraft,
  retentionDraft,
  type RetentionDraft,
} from "./retention-state.ts";

const policy = Schema.decodeUnknownSync(OrganizationRetentionPolicyResponse)({
  artifacts: 365,
  audit: 2555,
  createdAt: "2026-10-01T00:00:00.000Z",
  events: 365,
  messages: 365,
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G600C",
  runs: 365,
  threads: 365,
  updatedAt: "2026-10-01T00:00:00.000Z",
  updatedByPrincipalId: "01ARZ3NDEKTSV4RRFFQ69G600C",
  version: 0,
});

const draft = (changes: Partial<RetentionDraft>): RetentionDraft => ({
  ...retentionDraft(policy),
  ...changes,
});

describe("retention bounds", () => {
  test("the editor lists exactly the contract's classes", () => {
    expect(RETENTION_CLASSES.map(({ field }) => field).toSorted()).toEqual(
      [...RetentionResource.literals].toSorted(),
    );
  });

  test("each class's bounds are the contract's bounds", () => {
    for (const { field, maxDays, minDays } of RETENTION_CLASSES) {
      const decode = Schema.decodeUnknownExit(
        field === "audit" ? AuditRetentionDays : RetentionDays,
      );
      expect(
        [minDays - 1, minDays, maxDays, maxDays + 1].map((days) => Exit.isSuccess(decode(days))),
      ).toEqual([false, true, true, false]);
    }
  });
});

describe("planRetention", () => {
  test("the current values plan no change", () => {
    expect(planRetention(retentionDraft(policy), policy)).toEqual({ kind: "unchanged" });
  });

  test("a raised value patches only that class", () => {
    expect(planRetention(draft({ runs: " 400 " }), policy)).toEqual({
      kind: "change",
      patch: { runs: 400 },
      shortened: [],
    });
  });

  test("a lowered value is flagged as shortened", () => {
    expect(planRetention(draft({ audit: "365", threads: "30" }), policy)).toEqual({
      kind: "change",
      patch: { audit: 365, threads: 30 },
      shortened: ["threads", "audit"],
    });
  });

  test("out-of-bounds and non-integer values are issues per class", () => {
    expect(
      planRetention(
        draft({ artifacts: "", audit: "364", events: "12.5", messages: "3651", runs: "0" }),
        policy,
      ),
    ).toEqual({
      issues: [
        { field: "messages", message: "Enter whole days from 1 to 3650." },
        { field: "runs", message: "Enter whole days from 1 to 3650." },
        { field: "artifacts", message: "Enter whole days from 1 to 3650." },
        { field: "events", message: "Enter whole days from 1 to 3650." },
        { field: "audit", message: "Enter whole days from 365 to 3650." },
      ],
      kind: "invalid",
    });
  });
});

describe("patchApplied", () => {
  test("a policy holding every patched value has the patch applied", () => {
    expect(patchApplied({ ...policy, runs: 400 }, { runs: 400 })).toBe(true);
    expect(patchApplied(policy, { runs: 400 })).toBe(false);
    expect(patchApplied({ ...policy, runs: 400 }, { audit: 400, runs: 400 })).toBe(false);
  });
});

describe("rebaseRetentionDraft", () => {
  test("keeps the operator's edits and moves every untouched class to the reloaded policy", () => {
    const reloaded = { ...policy, events: 90, runs: 500, version: 1 };
    expect(rebaseRetentionDraft(draft({ runs: "400", threads: " 30 " }), policy, reloaded)).toEqual(
      {
        artifacts: "365",
        audit: "2555",
        events: "90",
        messages: "365",
        runs: "400",
        threads: " 30 ",
      },
    );
  });

  test("a class re-typed to the same number counts as untouched", () => {
    const reloaded = { ...policy, events: 90, runs: 500, version: 1 };
    expect(
      rebaseRetentionDraft(draft({ events: "0365", runs: " 365 " }), policy, reloaded),
    ).toEqual({
      artifacts: "365",
      audit: "2555",
      events: "90",
      messages: "365",
      runs: "500",
      threads: "365",
    });
  });
});
