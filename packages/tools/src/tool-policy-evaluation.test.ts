import { describe, expect, test } from "bun:test";
import {
  decideToolPolicy,
  findPlatformToolAdapterDefinition,
  platformToolAdapterDefinitions,
  toolCatalogDenial,
  toolCatalogStatus,
  toolExecutionRoute,
  type ToolAdapterDefinition,
  type ToolPolicyConnection,
} from "./index.ts";

function platform(toolName: string): ToolAdapterDefinition {
  const definition = findPlatformToolAdapterDefinition(toolName);
  if (!definition) throw new Error(`Missing catalog tool ${toolName}.`);
  return definition;
}

const policyRules = {
  defaultAction: "deny",
  rules: [
    { action: "deny", reason: "Orders are off limits.", toolName: "shopify.orders.search" },
    { action: "require_approval", toolPrefix: "shopify.customers." },
    { action: "allow", providerKey: "shopify", requiredScopes: ["read_inventory"] },
    { action: "allow", effect: "read", providerKey: "shopify" },
  ],
};
const shopify = (grantedScopes: readonly string[]): ToolPolicyConnection => ({
  connectorProvider: "shopify",
  grantedScopes,
  policyRules,
});

describe("runtime tool policy decisions", () => {
  test.each([
    {
      case: "exact tool-name deny with its reason",
      connection: shopify(["read_orders"]),
      expected: { action: "deny", basis: "rule", matchedRuleIndex: 0 },
      reason: "Orders are off limits.",
      toolName: "shopify.orders.search",
    },
    {
      case: "prefix require_approval",
      connection: shopify(["read_customers"]),
      expected: { action: "require_approval", basis: "rule", matchedRuleIndex: 1 },
      toolName: "shopify.customers.search",
    },
    {
      case: "provider rule gated on granted scopes",
      connection: shopify(["read_inventory"]),
      expected: { action: "allow", basis: "rule", matchedRuleIndex: 2 },
      toolName: "shopify.inventory_levels.list",
    },
    {
      case: "provider rule with an effect filter",
      connection: shopify(["read_products"]),
      expected: { action: "allow", basis: "rule", matchedRuleIndex: 3 },
      toolName: "shopify.products.search",
    },
    {
      case: "policy default when no rule matches",
      connection: shopify(["write_inventory"]),
      expected: { action: "deny", basis: "default" },
      toolName: "shopify.inventory.adjust",
    },
    {
      case: "a different connector provider never matches provider rules",
      connection: { ...shopify(["read_products"]), connectorProvider: "twilio" },
      expected: { action: "deny", basis: "default" },
      toolName: "shopify.products.search",
    },
    {
      case: "missing connector scopes deny before rules",
      connection: shopify([]),
      expected: { action: "deny", basis: "required_scopes" },
      toolName: "shopify.products.search",
    },
    {
      case: "catalog default when the binding pins no policy",
      connection: { connectorProvider: "shopify", grantedScopes: ["write_fulfillments"] },
      expected: { action: "require_approval", basis: "default" },
      reason: "Tool adapter shopify.fulfillments.create defaults to require_approval.",
      toolName: "shopify.fulfillments.create",
    },
    {
      case: "catalog tools ignore environment policies",
      connection: undefined,
      expected: { action: "allow", basis: "default" },
      reason: "Tool adapter artifact.inspect defaults to allow.",
      toolName: "artifact.inspect",
    },
  ])("$case", ({ connection, expected, reason, toolName }) => {
    const decision = decideToolPolicy(platform(toolName), connection);
    expect(decision).toMatchObject(expected);
    if (!("matchedRuleIndex" in expected)) expect(decision.matchedRuleIndex).toBeUndefined();
    if (reason) expect(decision.reason).toBe(reason);
  });

  test("policy default reasons fall back to the catalog when the policy omits them", () => {
    expect(
      decideToolPolicy(platform("shopify.products.search"), {
        connectorProvider: "shopify",
        grantedScopes: ["read_products"],
        policyRules: { rules: [] },
      }),
    ).toEqual({
      action: "allow",
      basis: "default",
      reason: "Tool adapter shopify.products.search defaults to allow.",
    });
  });

  test("admits only registered, active tools", () => {
    const archived = platformToolAdapterDefinitions.find(
      (definition) => definition.status === "archived",
    )!;
    expect(toolCatalogStatus("artifact.inspect", platform("artifact.inspect"))).toBe("active");
    expect(toolCatalogStatus(archived.toolName, archived)).toBe("archived");
    expect(toolCatalogDenial(archived.toolName, "archived")).toBe(
      `Runtime tool ${archived.toolName} is not active.`,
    );
    expect(toolCatalogStatus("custom.unknown", undefined)).toBe("unknown");
    expect(toolCatalogStatus("custom.unknown", platform("artifact.inspect"))).toBe("unknown");
    expect(toolCatalogDenial("custom.unknown", "unknown")).toBe(
      "Runtime tool custom.unknown is not registered.",
    );
    expect(toolCatalogDenial("artifact.inspect", "active")).toBeUndefined();
  });

  test("gives every catalog definition a worker execution route", () => {
    expect(
      platformToolAdapterDefinitions
        .filter((definition) => toolExecutionRoute(definition) === undefined)
        .map((definition) => definition.toolName),
    ).toEqual([]);
  });
});
