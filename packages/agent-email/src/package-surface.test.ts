import { describe, expect, it } from "bun:test";
import { agentEmailPlan } from "@deployments-ai/agent-email";
import { agentEmailSesTenantName } from "@deployments-ai/agent-email/aws";

describe("agent email package surface", () => {
  it("exposes core and AWS adapter boundaries without owning persistence", () => {
    expect(agentEmailPlan("developer").code).toBe("developer");
    expect(agentEmailSesTenantName("organization-1")).toStartWith("agent-inboxes-");
  });
});
