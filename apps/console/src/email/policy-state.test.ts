import { AgentEmailPolicyResponse } from "@deployments-ai/api-contract";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { policyChanges, policyDraft } from "./policy-state.ts";
import type { PolicyState } from "./setup-state.ts";

const SAVED: PolicyState = {
  kind: "saved",
  policy: Schema.decodeUnknownSync(AgentEmailPolicyResponse)({
    allowlist: ["ops@example.com"],
    bounceRateThresholdBasisPoints: 500,
    complaintRateThresholdBasisPoints: 10,
    createdAt: "2026-10-01T12:00:00.000Z",
    dailyOutboundMessageLimit: 1000,
    id: "01J9ZQ4V6X8Y2K3M5N7P9R1TQ1",
    maxAttachmentBytes: 4_194_304,
    maxRecipientsPerMessage: 47,
    organizationId: "01J9ZQ4V6X8Y2K3M5N7P9R1T30",
    rawRetentionDays: 30,
    sendingStatus: "active",
    updatedAt: "2026-10-01T12:00:00.000Z",
    warmupStage: "sandbox",
  }),
};

const DEFAULTS: PolicyState = { kind: "defaults" };

describe("policyDraft and policyChanges", () => {
  test("an untouched saved policy has no changes", () => {
    expect(policyChanges(policyDraft(SAVED), SAVED)).toEqual({ kind: "unchanged" });
  });

  test("sends only the fields that differ", () => {
    const draft = {
      ...policyDraft(SAVED),
      allowlist: "OPS@example.com, qa@example.com",
      rawRetentionDays: "45",
      warmupStage: "ramp_1" as const,
    };
    expect(policyChanges(draft, SAVED)).toEqual({
      body: {
        allowlist: ["ops@example.com", "qa@example.com"],
        rawRetentionDays: 45,
        warmupStage: "ramp_1",
      },
      kind: "changes",
    });
  });

  test("an unsaved policy starts blank and blank fields keep the runtime defaults", () => {
    const draft = policyDraft(DEFAULTS);
    expect(draft.dailyOutboundMessageLimit).toBe("");
    expect(policyChanges(draft, DEFAULTS)).toEqual({ kind: "unchanged" });
    expect(policyChanges({ ...draft, blocklist: "spam@example.com" }, DEFAULTS)).toEqual({
      body: { blocklist: ["spam@example.com"] },
      kind: "changes",
    });
  });

  test("refuses values outside the contract bounds", () => {
    expect(policyChanges({ ...policyDraft(SAVED), maxRecipientsPerMessage: "48" }, SAVED)).toEqual({
      kind: "invalid",
      message: "Recipients per message must be a whole number from 1 to 47.",
    });
    expect(policyChanges({ ...policyDraft(SAVED), rawRetentionDays: "1.5" }, SAVED)).toEqual({
      kind: "invalid",
      message: "Raw message retention must be a whole number from 1 to 365.",
    });
    expect(policyChanges({ ...policyDraft(SAVED), blocklist: "not-an-address" }, SAVED)).toEqual({
      kind: "invalid",
      message: "not-an-address is not an email address.",
    });
  });
});
