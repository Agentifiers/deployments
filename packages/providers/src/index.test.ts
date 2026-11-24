import { describe, expect, test } from "bun:test";

import {
  applyProviderAuthTransport,
  codeProviderDefinitionRegistry,
  makeProviderDefinitionRecord,
  evaluateToolPolicy,
} from "./index.ts";

describe("provider catalog", () => {
  test("loads the complete auth-aware provider registry", () => {
    const registry = codeProviderDefinitionRegistry();
    expect(registry.list().length).toBe(173);
    expect(registry.list().filter((definition) => definition.route === "vendor_mcp").length).toBe(
      132,
    );
    const awsRcs = registry.getByKey("aws_end_user_messaging_rcs");
    expect(awsRcs).toMatchObject({ auth: { kind: "service_account" }, status: "configured" });
    expect(awsRcs?.auth.fields.find((field) => field.key === "roleArn")?.sensitive).toBe(false);
    expect(awsRcs?.auth.fields.find((field) => field.key === "externalId")?.sensitive).toBe(true);
    const slack = registry.getByKey("slack");
    expect(slack).toMatchObject({ auth: { kind: "oauth" }, route: "vendor_mcp" });
    expect(slack?.tools).toEqual([]);
    expect(registry.getByKey("extension_callback")).toMatchObject({
      auth: { kind: "none" },
      defaultScopes: expect.arrayContaining([
        "callback:context:read",
        "callback:action:execute",
        "callback:action:privileged",
        "callback:workflow:coordinate",
      ]),
      route: "platform_webhook",
      status: "configured",
    });
    expect(registry.getByKey("hubspot")?.authorizationScopeMode).toBe("manifest");
    expect(registry.getByAlias("jira")?.key).toBe("atlassian");
    expect(registry.getByAlias("confluence")?.key).toBe("atlassian");
    expect(registry.getByKey("telegram")).toBeUndefined();
    expect(registry.getByKey("fanvue")).toBeUndefined();
    expect(
      registry
        .list()
        .every((definition) =>
          definition.auth.fields.every((field) => !field.defaultValue || !field.sensitive),
        ),
    ).toBe(true);
  });

  test("gives every configured API-probe provider an executable probe", () => {
    const registry = codeProviderDefinitionRegistry();
    const missing = registry
      .list()
      .filter(
        (definition) =>
          definition.status === "configured" &&
          definition.verification.method === "api_probe" &&
          !definition.verification.probe,
      )
      .map((definition) => definition.key);
    expect(missing).toEqual([]);
    expect(registry.getByKey("snowflake")).toMatchObject({
      originPolicy: { fieldKey: "accountUrl", hostMatch: "suffix" },
      status: "configured",
      verification: {
        method: "api_probe",
        probe: { method: "POST", path: "/api/v2/statements" },
      },
    });
  });

  test("applies static credential transports without exposing them in definitions", () => {
    expect(
      applyProviderAuthTransport({
        fields: { apiKey: "secret" },
        transport: { fieldKey: "apiKey", prefix: "Bearer ", type: "bearer" },
        url: "https://api.example.com/v1",
      }),
    ).toEqual({ headers: { authorization: "Bearer secret" }, url: "https://api.example.com/v1" });
  });

  test("projects definitions into canonical DynamoDB records", () => {
    const twilio = codeProviderDefinitionRegistry().getByKey("twilio");
    expect(twilio).toBeDefined();
    const record = makeProviderDefinitionRecord({
      definition: twilio!,
      occurredAt: "2026-07-21T00:00:00.000Z",
    });
    expect(record.itemType).toBe("provider-definition");
    expect(record.data.route).toBe("static");
    expect(record.data.supportedTools).toContain("twilio.messages.send");
  });

  test("fails closed when connector scopes are missing", () => {
    expect(
      evaluateToolPolicy(undefined, {
        effect: "read",
        grantedScopes: ["messages:read"],
        requiredScopes: ["messages:read", "users:read"],
        toolName: "twilio.messages.list",
      }),
    ).toEqual({
      action: "deny",
      basis: "required_scopes",
      reason: "Required connector scopes have not been granted.",
    });
  });

  test("scopes public policy rules to their provider key", () => {
    const policy = {
      defaultAction: "deny",
      rules: [{ action: "allow", providerKey: "shopify", toolPrefix: "shared." }],
    };
    expect(
      evaluateToolPolicy(policy, {
        connectorProvider: "shopify",
        effect: "read",
        toolName: "shared.records.list",
      }),
    ).toMatchObject({ action: "allow" });
    expect(
      evaluateToolPolicy(policy, {
        connectorProvider: "twilio",
        effect: "read",
        toolName: "shared.records.list",
      }),
    ).toMatchObject({ action: "deny" });
  });

  test("canonicalizes provider aliases before matching policy rules", () => {
    const policy = {
      defaultAction: "allow",
      rules: [{ action: "deny", providerKey: "jira", toolPrefix: "shared." }],
    };
    expect(
      evaluateToolPolicy(policy, {
        connectorProvider: "atlassian",
        effect: "read",
        toolName: "shared.records.list",
      }),
    ).toMatchObject({ action: "deny" });
  });

  test("matches exact unregistered provider contexts such as custom MCP", () => {
    expect(
      evaluateToolPolicy(
        {
          defaultAction: "allow",
          rules: [{ action: "deny", providerKey: "mcp", toolPrefix: "custom." }],
        },
        {
          connectorProvider: "mcp",
          effect: "read",
          toolName: "custom.records.list",
        },
      ),
    ).toMatchObject({ action: "deny" });
  });
});
