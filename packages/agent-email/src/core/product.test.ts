import { describe, expect, it } from "bun:test";
import {
  AgentEmailEntitlementError,
  agentEmailEffectiveDailyLimit,
  agentEmailPlan,
  agentEmailSubscriptionCanSend,
  agentEmailWarmupRequiresVerifiedRecipients,
  assertAgentEmailQuota,
} from "./product.ts";

describe("agent email product policy", () => {
  it("publishes increasing standalone plan limits", () => {
    expect(agentEmailPlan("sandbox").entitlements.inboxLimit).toBe(3);
    expect(agentEmailPlan("developer").entitlements.inboxLimit).toBeGreaterThan(3);
    expect(agentEmailPlan("pro").entitlements.monthlyOutboundMessageLimit).toBeGreaterThan(
      agentEmailPlan("developer").entitlements.monthlyOutboundMessageLimit,
    );
    expect(agentEmailPlan("scale").entitlements.dedicatedPlacementAllowed).toBe(true);
  });

  it("allows only usable subscription states to send", () => {
    expect(agentEmailSubscriptionCanSend("trialing")).toBe(true);
    expect(agentEmailSubscriptionCanSend("active")).toBe(true);
    expect(agentEmailSubscriptionCanSend("past_due")).toBe(false);
    expect(agentEmailSubscriptionCanSend("canceled")).toBe(false);
  });

  it("caps daily sending during warmup", () => {
    expect(agentEmailEffectiveDailyLimit({ policyLimit: 5_000, warmupStage: "sandbox" })).toBe(20);
    expect(agentEmailEffectiveDailyLimit({ policyLimit: 100, warmupStage: "ramp_2" })).toBe(100);
    expect(agentEmailEffectiveDailyLimit({ policyLimit: 5_000, warmupStage: "production" })).toBe(
      5_000,
    );
    expect(agentEmailWarmupRequiresVerifiedRecipients("ramp_1")).toBe(true);
    expect(agentEmailWarmupRequiresVerifiedRecipients("ramp_2")).toBe(false);
  });

  it("rejects quota consumption beyond the plan limit", () => {
    expect(() => assertAgentEmailQuota({ dimension: "inboxes", limit: 3, usage: 2 })).not.toThrow();
    expect(() => assertAgentEmailQuota({ dimension: "inboxes", limit: 3, usage: 3 })).toThrow(
      AgentEmailEntitlementError,
    );
  });
});
