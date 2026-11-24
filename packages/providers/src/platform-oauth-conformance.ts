import type { PlatformOAuthAppProtocolConfig, PlatformOAuthAppRegistry } from "./platform-oauth.ts";
import type { ProviderDefinition } from "./provider-definitions.ts";
import { PLATFORM_OAUTH_ASSERTIONS } from "./platform-oauth-conformance-assertions.ts";
import type { OAuthAppAssertion } from "./platform-oauth-conformance-helpers.ts";
import { fail } from "./platform-oauth-conformance-helpers.ts";

const assertions: Readonly<Record<string, OAuthAppAssertion>> = PLATFORM_OAUTH_ASSERTIONS;

export function assertPlatformOAuthAppConformance(
  key: string,
  app: PlatformOAuthAppProtocolConfig,
): void {
  const assertion = assertions[key];
  if (!assertion) fail(key, "has no reviewed provider conformance profile.");
  assertion(app);
}

export function assertConfiguredPlatformOAuthRegistryConformance(
  registry: PlatformOAuthAppRegistry,
  definitions: readonly ProviderDefinition[],
): void {
  assertPlatformOAuthRegistryConformance(registry, definitions, true);
}

export function assertPresentPlatformOAuthRegistryConformance(
  registry: PlatformOAuthAppRegistry,
  definitions: readonly ProviderDefinition[],
): void {
  assertPlatformOAuthRegistryConformance(registry, definitions, false);
}

function assertPlatformOAuthRegistryConformance(
  registry: PlatformOAuthAppRegistry,
  definitions: readonly ProviderDefinition[],
  requireAll: boolean,
): void {
  const configured = definitions.filter(
    (definition) =>
      definition.route === "platform_oauth" &&
      (definition.status === "configured" || definition.status === "verified"),
  );
  const configuredKeys = new Set(configured.map((definition) => definition.oauthProviderKey));
  for (const [key, app] of Object.entries(registry)) {
    if (!configuredKeys.has(key)) {
      fail(key, "is not referenced by a configured provider definition.");
    }
    assertPlatformOAuthAppConformance(key, app);
  }
  for (const definition of configured) {
    const key = definition.oauthProviderKey;
    if (!key) fail(definition.key, "definition is missing oauthProviderKey.");
    const app = registry[key];
    if (!app) {
      if (requireAll) fail(key, "is required by a configured provider definition.");
      continue;
    }
    const appResources = [...app.allowedResources].toSorted();
    const definitionResources = [...definition.oauthResources].toSorted();
    if (JSON.stringify(appResources) !== JSON.stringify(definitionResources)) {
      fail(key, `allowedResources must match provider ${definition.key} oauthResources.`);
    }
  }
}
