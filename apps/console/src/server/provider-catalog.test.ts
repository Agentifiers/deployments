import { codeProviderDefinitionRegistry } from "@deployments-ai/providers";
import { describe, expect, test } from "bun:test";
import { catalogEntry, providerCatalog } from "./provider-catalog.ts";

const registry = codeProviderDefinitionRegistry();

function entry(key: string) {
  const definition = registry.resolve(key);
  if (!definition) throw new Error(`${key} is not in the provider registry.`);
  return catalogEntry(definition);
}

describe("catalogEntry", () => {
  test("renders each declared credential field, masking secrets", () => {
    expect(
      entry("wordpress")?.fields.map((field) => [field.key, field.label, field.sensitive]),
    ).toEqual([
      ["baseUrl", "Site base URL", false],
      ["username", "Username", false],
      ["appPassword", "Application password", true],
    ]);
  });

  test("classifies how each provider connects", () => {
    expect(
      ["demio", "extension_callback", "google_ads", "rb2b"].map((key) => [
        key,
        entry(key)?.access,
        entry(key)?.verifiable,
      ]),
    ).toEqual([
      ["demio", "credential", true],
      ["extension_callback", "credentialless", false],
      ["google_ads", "oauth", true],
      ["rb2b", undefined, undefined],
    ]);
  });

  test("asks for the tenant of a templated vendor server", () => {
    expect(entry("freshdesk")?.resource).toEqual({
      label: "Freshdesk subdomain",
      template: "https://{tenant}.freshdesk.com/mcp",
    });
  });

  test("describes how each OAuth provider's apps register and call back", () => {
    expect(
      ["google_ads", "github", "notion", "google_calendar"].map((key) => {
        const provider = entry(key);
        return provider?.access === "oauth"
          ? [
              key,
              provider.oauth.callbackKey,
              provider.oauth.requiresApp,
              provider.oauth.tokenEndpointAuthMethods ?? "platform",
            ]
          : [key, provider?.access];
      }),
    ).toEqual([
      ["google_ads", "google", true, "platform"],
      ["github", "github", true, ["client_secret_basic"]],
      ["notion", "notion", false, ["none", "client_secret_basic", "client_secret_post"]],
      ["google_calendar", "google-calendar", true, ["client_secret_basic", "client_secret_post"]],
    ]);
    const ads = entry("google_ads");
    expect(ads?.access === "oauth" && ads.oauth.appScopes).toEqual([
      "email",
      "https://www.googleapis.com/auth/adwords",
      "openid",
    ]);
  });
});

describe("providerCatalog", () => {
  test("lists only configured providers the console can connect", () => {
    const keys = new Set(providerCatalog().map((provider) => provider.key));
    expect(
      ["extension_callback", "demio", "rb2b", "bitbucket"].map((key) => keys.has(key)),
    ).toEqual([true, true, false, false]);
  });
});
