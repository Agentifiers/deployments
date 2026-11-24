import { describe, expect, it } from "bun:test";

import {
  BIFROST_CONFIG_STORE_PATH,
  BIFROST_INTERNAL_VIRTUAL_KEY_ID,
  createBifrostConfig,
  createBifrostConfigJson,
  generateBifrostInternalVirtualKey,
} from "./bifrost-config.ts";

const internalVirtualKey = `sk-bf-${"a".repeat(43)}`;

describe("Bifrost config", () => {
  it("renders a file-sourced config with a task-local store and one internal virtual key", () => {
    expect(
      createBifrostConfig({
        bedrockRegion: "us-east-2",
        hostedProviders: ["bedrock", "openai", "openrouter"],
        internalVirtualKey,
      }),
    ).toEqual({
      $schema: "https://www.getbifrost.ai/schema",
      version: 2,
      source_of_truth: "config.json",
      client: {
        allow_direct_keys: true,
        disable_content_logging: true,
        drop_excess_requests: false,
        enable_logging: false,
        enforce_auth_on_inference: true,
      },
      providers: {
        bedrock: {
          keys: [
            {
              name: "deployments-ai-bedrock",
              value: "",
              models: ["*"],
              weight: 1,
              bedrock_key_config: { region: "us-east-2" },
            },
          ],
        },
        openai: {
          keys: [
            {
              name: "deployments-ai-openai",
              value: "env.OPENAI_API_KEY",
              models: ["*"],
              weight: 1,
            },
          ],
        },
        openrouter: {
          keys: [
            {
              name: "deployments-ai-openrouter",
              value: "env.OPENROUTER_API_KEY",
              models: ["*"],
              weight: 1,
            },
          ],
        },
      },
      governance: {
        virtual_keys: [
          {
            id: BIFROST_INTERNAL_VIRTUAL_KEY_ID,
            name: "deployments.ai model gateway",
            value: internalVirtualKey,
            is_active: true,
            provider_configs: (["bedrock", "openai", "openrouter"] as const).map((provider) => ({
              provider,
              weight: 1,
              allowed_models: ["*"],
              key_ids: ["*"],
            })),
          },
        ],
      },
      config_store: { enabled: true, type: "sqlite", config: { path: "/app/data/config.db" } },
      logs_store: { enabled: false },
    });
    expect(BIFROST_CONFIG_STORE_PATH).toBe("/app/data/config.db");
  });

  it("renders only hosted providers and no credentials, encryption, auth, or env label", () => {
    const config = createBifrostConfig({
      hostedProviders: ["openrouter", "openrouter"],
      internalVirtualKey,
    });
    expect(Object.keys(config.providers)).toEqual(["openrouter"]);
    expect(config.governance.virtual_keys).toHaveLength(1);
    expect(config.governance.virtual_keys[0]?.provider_configs).toEqual([
      { provider: "openrouter", weight: 1, allowed_models: ["*"], key_ids: ["*"] },
    ]);
    expect(Object.keys(config)).not.toContain("auth_config");
    expect(Object.keys(config)).not.toContain("encryption_key");

    const json = createBifrostConfigJson({ hostedProviders: ["openai"], internalVirtualKey });
    expect(json).not.toMatch(
      /postgres|encryption|auth_config|admin|env_label|access_key|secret_key|session_token|AWS_/iu,
    );
    expect(JSON.parse(json)).toEqual(
      createBifrostConfig({ hostedProviders: ["openai"], internalVirtualKey }),
    );
  });

  it("requires a valid AWS region exactly when Bedrock is hosted", () => {
    expect(() => createBifrostConfig({ hostedProviders: ["bedrock"], internalVirtualKey })).toThrow(
      "A Bedrock region is required exactly when the bedrock provider is hosted.",
    );
    expect(() =>
      createBifrostConfig({
        bedrockRegion: "  ",
        hostedProviders: ["bedrock"],
        internalVirtualKey,
      }),
    ).toThrow("A Bedrock region is required exactly when the bedrock provider is hosted.");
    expect(() =>
      createBifrostConfig({
        bedrockRegion: "us-east-2",
        hostedProviders: ["openai"],
        internalVirtualKey,
      }),
    ).toThrow("A Bedrock region is required exactly when the bedrock provider is hosted.");
    expect(() =>
      createBifrostConfig({
        bedrockRegion: "us-east",
        hostedProviders: ["bedrock"],
        internalVirtualKey,
      }),
    ).toThrow("is not an AWS region name");
    expect(
      createBifrostConfig({
        bedrockRegion: " eu-central-1 ",
        hostedProviders: ["bedrock"],
        internalVirtualKey,
      }).providers.bedrock?.keys[0]?.bedrock_key_config,
    ).toEqual({ region: "eu-central-1" });
  });

  it("rejects empty or unsupported provider lists", () => {
    expect(() => createBifrostConfig({ hostedProviders: [], internalVirtualKey })).toThrow(
      "At least one hosted Bifrost provider must be enabled.",
    );
    expect(() =>
      createBifrostConfig({ hostedProviders: ["anthropic" as never], internalVirtualKey }),
    ).toThrow("Bifrost provider anthropic is not supported.");
  });

  it("points only the openai provider at an OpenAI-compatible origin", () => {
    const providers = createBifrostConfig({
      hostedProviders: ["openai", "openrouter"],
      internalVirtualKey,
      openAiBaseUrl: " http://10.42.32.17:8317 ",
    }).providers;
    expect(providers.openai?.network_config).toEqual({
      allow_private_network: true,
      base_url: "http://10.42.32.17:8317",
    });
    expect(providers.openrouter).not.toHaveProperty("network_config");
    expect(() =>
      createBifrostConfig({
        hostedProviders: ["openrouter"],
        internalVirtualKey,
        openAiBaseUrl: "http://10.42.32.17:8317",
      }),
    ).toThrow("An OpenAI base URL requires the openai provider to be hosted.");
    for (const openAiBaseUrl of [
      "http://10.42.32.17:8317/",
      "http://10.42.32.17:8317/v1",
      "ftp://10.42.32.17",
      "10.42.32.17:8317",
    ]) {
      expect(() =>
        createBifrostConfig({ hostedProviders: ["openai"], internalVirtualKey, openAiBaseUrl }),
      ).toThrow("is not an http(s) origin");
    }
  });

  it("validates the internal virtual key format", () => {
    for (const key of ["", "sk-bf-short", `bf-${"a".repeat(43)}`, `sk-bf-${"a".repeat(42)}`]) {
      expect(() =>
        createBifrostConfig({ hostedProviders: ["openai"], internalVirtualKey: key }),
      ).toThrow("The internal Bifrost virtual key must be sk-bf- followed by 32+ random bytes.");
    }
    expect(() =>
      createBifrostConfig({
        hostedProviders: ["openai"],
        internalVirtualKey: `sk-bf-${"a".repeat(42)}+`,
      }),
    ).toThrow("internal Bifrost virtual key");
  });

  it("generates distinct valid internal virtual keys", () => {
    const first = generateBifrostInternalVirtualKey();
    const second = generateBifrostInternalVirtualKey();
    expect(first).toMatch(/^sk-bf-[A-Za-z0-9_-]{43}$/u);
    expect(first).not.toBe(second);
    expect(() =>
      createBifrostConfig({ hostedProviders: ["openai"], internalVirtualKey: first }),
    ).not.toThrow();
  });
});
