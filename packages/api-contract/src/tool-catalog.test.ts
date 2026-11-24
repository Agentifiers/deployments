import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { decodePublicRequest } from "./validation.ts";
import { EvaluateToolPolicyRequest, TOOL_CATALOG_API_ROUTES } from "./tool-catalog.ts";

const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const decode = Schema.decodeUnknownSync(EvaluateToolPolicyRequest);

describe("tool catalog API contract", () => {
  test("serves read-only environment routes under tools:read", () => {
    for (const route of TOOL_CATALOG_API_ROUTES) {
      expect(route).toMatchObject({
        authentication: "platform-bearer",
        idempotency: "none",
        requiredAuthorization: "tools:read",
        scopeHeaders: "environment",
      });
    }
  });

  test("accepts a policy with explicit tools or a deployment with optional tools", () => {
    expect(decode({ toolNames: ["shopify.orders.search"], toolPolicyId: ID })).toBeDefined();
    expect(decode({ agentDeploymentId: ID }) as unknown).toEqual({ agentDeploymentId: ID });
    expect(
      decodePublicRequest("evaluateToolPolicy", { agentDeploymentId: ID, toolNames: ["a.b"] }),
    ).toEqual({ agentDeploymentId: ID, toolNames: ["a.b"] });
    for (const invalid of [
      { toolPolicyId: ID },
      { toolNames: [], toolPolicyId: ID },
      { toolNames: ["a.b", "a.b"], toolPolicyId: ID },
      { agentDeploymentId: ID, toolNames: Array.from({ length: 101 }, (_, i) => `tool.n${i}`) },
      { toolNames: ["a.b"] },
    ]) {
      expect(() => decode(invalid)).toThrow();
    }
  });
});
