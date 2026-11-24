import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appConfig } from "./oauth-validation.ts";

const protocol = {
  github: {
    authorizationEndpoint: "https://github.com/login/oauth/authorize",
    clientAuthentication: "client_secret_post",
    clientId: "configured-client-id",
    redirectUri: "https://channels.example.test/public/provider-connections/oauth/callback/github",
    tokenEndpoint: "https://github.com/login/oauth/access_token",
  },
};

const application = {
  data: { clientId: "application-client-id", providerKey: "github" },
} as unknown as Parameters<typeof appConfig>[0];

describe("appConfig", () => {
  const previous = process.env.PLATFORM_OAUTH_APPS_JSON;
  beforeEach(() => {
    process.env.PLATFORM_OAUTH_APPS_JSON = JSON.stringify(protocol);
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.PLATFORM_OAUTH_APPS_JSON;
    else process.env.PLATFORM_OAUTH_APPS_JSON = previous;
  });

  test("resolves the client credentials from the provider application vault values", () => {
    const config = appConfig(application, { clientSecret: "vault-client-secret" });
    expect(config.clientId).toBe("application-client-id");
    expect(config.clientSecret).toBe("vault-client-secret");
    expect(config.tokenEndpoint).toBe("https://github.com/login/oauth/access_token");
  });

  test("builds authorization config without any client secret", () => {
    expect(appConfig(application)).not.toHaveProperty("clientSecret");
  });

  test("fails when the vault credential has no client secret", () => {
    expect(() => appConfig(application, {})).toThrow("clientSecret");
  });
});
