import { describe, expect, test } from "bun:test";
import { toolSyncFixture } from "./vendor-mcp-tool-sync.fixture.ts";

const RESOURCE = "https://acme.tenant-keyed.example/mcp";
const body = {
  credential: { apiKey: "tenant-secret-0123456789" },
  displayName: "Acme support",
  providerKey: "tenant_keyed",
};

describe("templated api_key vendor MCP credentials", () => {
  test("persist the tenant endpoint as the connection resource", async () => {
    const fixture = toolSyncFixture();
    await fixture.invoke("createProviderCredential", { ...body, requestedResource: RESOURCE });
    expect(fixture.recordsOf("provider-connection").map((record) => record.data)).toEqual([
      expect.objectContaining({ oauthResource: RESOURCE, providerKey: "tenant_keyed" }),
    ]);
  });

  for (const [label, requestedResource] of [
    ["a missing", undefined],
    ["an off-suffix", "https://acme.attacker.example/mcp"],
    ["a non-template", "https://acme.tenant-keyed.example/other"],
  ] as const) {
    test(`reject ${label} tenant endpoint with 422`, async () => {
      const fixture = toolSyncFixture();
      expect(
        fixture.invoke("createProviderCredential", {
          ...body,
          ...(requestedResource ? { requestedResource } : {}),
        }),
      ).rejects.toMatchObject({ code: "invalid_oauth_resource", kind: "unprocessable" });
      expect(fixture.recordsOf("provider-connection")).toEqual([]);
    });
  }

  test("reject requestedResource for providers that do not serve vendor MCP", async () => {
    const fixture = toolSyncFixture();
    expect(
      fixture.invoke("createProviderCredential", {
        credential: { appPassword: "secret", baseUrl: "https://blog.example", username: "me" },
        displayName: "Blog",
        providerKey: "wordpress",
        requestedResource: RESOURCE,
      }),
    ).rejects.toMatchObject({ code: "requested_resource_unsupported", kind: "unprocessable" });
  });

  test("sync tools against the persisted tenant endpoint", async () => {
    const fixture = toolSyncFixture({ discover: async () => ({ tools: [] }) });
    fixture.seedConnection({ oauthResource: RESOURCE, providerKey: "tenant_keyed" });
    await fixture.invoke("syncConnectionTools");
    expect(fixture.discoveries[0]).toMatchObject({
      endpointOrigin: "https://acme.tenant-keyed.example",
      endpointPath: "/mcp",
      headers: { authorization: "keyed-secret-0123456789" },
    });
  });

  test("reject a templated connection without a persisted endpoint as 422", async () => {
    const fixture = toolSyncFixture({ discover: async () => ({ tools: [] }) });
    fixture.seedConnection({ oauthResource: null, providerKey: "tenant_keyed" });
    expect(fixture.invoke("syncConnectionTools")).rejects.toMatchObject({
      code: "invalid_oauth_resource",
      kind: "unprocessable",
    });
    expect(fixture.discoveries).toEqual([]);
  });
});
