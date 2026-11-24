import { randomBytes } from "node:crypto";
import { MODEL_GATEWAY_PROVIDERS, type ModelGatewayProvider } from "./types.ts";

export type BifrostConfigArgs = {
  /** Deployment region, required exactly when `bedrock` is hosted. */
  readonly bedrockRegion?: string;
  readonly hostedProviders: readonly ModelGatewayProvider[];
  /** The one Bifrost virtual key, known only to the model gateway in the same task. */
  readonly internalVirtualKey: string;
  /**
   * Origin of an OpenAI-compatible endpoint that replaces api.openai.com for the hosted `openai`
   * provider, for example a relay to a self-hosted proxy.
   */
  readonly openAiBaseUrl?: string;
};

const BIFROST_SCHEMA_URL = "https://www.getbifrost.ai/schema";
const AWS_REGION_PATTERN = /^[a-z]{2}(?:-[a-z]+)+-\d+$/u;
const BIFROST_VIRTUAL_KEY_PATTERN = /^sk-bf-[A-Za-z0-9_-]{43,}$/u;

/**
 * Bifrost's config store lives on the task's ephemeral disk. Bifrost v2.2.x (verified v2.2.2
 * through v2.2.5) refuses to start with `config_store.enabled: false` because its governance
 * handler requires a store, so the store is a task-local SQLite file rebuilt from config.json on
 * every start; nothing outlives the task.
 */
export const BIFROST_CONFIG_STORE_PATH = "/app/data/config.db";

/** The Bifrost virtual key id the model gateway authenticates with. */
export const BIFROST_INTERNAL_VIRTUAL_KEY_ID = "deployments-ai-model-gateway";

/**
 * Bifrost v2 whitelists treat `["*"]` (alone) as every model and an empty list as none. Provider
 * keys and the internal virtual key route any provider model: gateway tokens and environment model
 * policies decide which models a caller runs.
 */
const BIFROST_ALL_MODELS = ["*"] as const;

/** A fresh internal virtual key in Bifrost's `sk-bf-` format: 32 random bytes, base64url. */
export function generateBifrostInternalVirtualKey() {
  return `sk-bf-${randomBytes(32).toString("base64url")}`;
}

/** Bifrost appends `/v1/...` to a provider base URL, so only a bare origin is accepted. */
function isHttpOrigin(value: string) {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (url.protocol === "http:" || url.protocol === "https:") && url.origin === value;
}

export function createBifrostConfig(args: BifrostConfigArgs) {
  const hostedProviders = [...new Set(args.hostedProviders)];
  if (hostedProviders.length === 0) {
    throw new Error("At least one hosted Bifrost provider must be enabled.");
  }
  const unsupported = hostedProviders.find(
    (provider) => !MODEL_GATEWAY_PROVIDERS.includes(provider),
  );
  if (unsupported) throw new Error(`Bifrost provider ${unsupported} is not supported.`);
  const bedrockRegion = args.bedrockRegion?.trim() || undefined;
  if (hostedProviders.includes("bedrock") !== (bedrockRegion !== undefined)) {
    throw new Error("A Bedrock region is required exactly when the bedrock provider is hosted.");
  }
  if (bedrockRegion !== undefined && !AWS_REGION_PATTERN.test(bedrockRegion)) {
    throw new Error(`Bedrock region ${bedrockRegion} is not an AWS region name.`);
  }
  if (!BIFROST_VIRTUAL_KEY_PATTERN.test(args.internalVirtualKey)) {
    throw new Error(
      "The internal Bifrost virtual key must be sk-bf- followed by 32+ random bytes.",
    );
  }
  const openAiBaseUrl = args.openAiBaseUrl?.trim() || undefined;
  if (openAiBaseUrl !== undefined) {
    if (!hostedProviders.includes("openai")) {
      throw new Error("An OpenAI base URL requires the openai provider to be hosted.");
    }
    if (!isHttpOrigin(openAiBaseUrl)) {
      throw new Error(`OpenAI base URL ${openAiBaseUrl} is not an http(s) origin.`);
    }
  }

  return {
    $schema: BIFROST_SCHEMA_URL,
    version: 2,
    source_of_truth: "config.json",
    client: {
      // Organization-funded requests carry the organization's key with `x-bf-direct-key: true`.
      // A direct key passes `enforce_auth_on_inference` without the virtual key, so this relies on
      // Bifrost listening only on the task loopback, where only the gateway calls it, and on the
      // gateway never forwarding a caller's `x-bf-direct-key` header.
      allow_direct_keys: true,
      disable_content_logging: true,
      drop_excess_requests: false,
      enable_logging: false,
      enforce_auth_on_inference: true,
    },
    providers: {
      ...(bedrockRegion !== undefined
        ? {
            // Bedrock signs with the Bifrost task role through the AWS SDK default credential
            // chain: Bifrost v1.10.1 skips bearer auth for an empty `value` and calls
            // `config.LoadDefaultConfig` when `bedrock_key_config` carries no access keys.
            bedrock: {
              keys: [
                {
                  name: "deployments-ai-bedrock",
                  value: "",
                  models: BIFROST_ALL_MODELS,
                  weight: 1,
                  bedrock_key_config: { region: bedrockRegion },
                },
              ],
            },
          }
        : {}),
      ...(hostedProviders.includes("openai")
        ? {
            openai: {
              keys: [
                {
                  name: "deployments-ai-openai",
                  value: "env.OPENAI_API_KEY",
                  models: BIFROST_ALL_MODELS,
                  weight: 1,
                },
              ],
              // Bifrost refuses private provider addresses unless the provider opts in, and an
              // operator-configured origin is expected to be a private relay inside the VPC.
              ...(openAiBaseUrl !== undefined
                ? { network_config: { allow_private_network: true, base_url: openAiBaseUrl } }
                : {}),
            },
          }
        : {}),
      ...(hostedProviders.includes("openrouter")
        ? {
            openrouter: {
              keys: [
                {
                  name: "deployments-ai-openrouter",
                  value: "env.OPENROUTER_API_KEY",
                  models: BIFROST_ALL_MODELS,
                  weight: 1,
                },
              ],
            },
          }
        : {}),
    },
    governance: {
      virtual_keys: [
        {
          id: BIFROST_INTERNAL_VIRTUAL_KEY_ID,
          name: "deployments.ai model gateway",
          value: args.internalVirtualKey,
          is_active: true,
          provider_configs: hostedProviders.map((provider) => ({
            provider,
            weight: 1,
            allowed_models: BIFROST_ALL_MODELS,
            key_ids: ["*"],
          })),
        },
      ],
    },
    config_store: {
      enabled: true,
      type: "sqlite",
      config: { path: BIFROST_CONFIG_STORE_PATH },
    },
    logs_store: { enabled: false },
  };
}

export function createBifrostConfigJson(args: BifrostConfigArgs) {
  return JSON.stringify(createBifrostConfig(args));
}
