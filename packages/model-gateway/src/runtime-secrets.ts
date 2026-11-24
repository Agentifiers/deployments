import { operatorGrantProviders, parseModelOperatorGrantsJson } from "./operator-grants.ts";
import type { ModelGatewayProvider } from "./types.ts";

export interface ModelRuntimeSecretInput {
  /**
   * Providers the deployment hosts (OpenTofu `model_runtime_hosted_providers`). Bedrock signs with
   * the Bifrost task role, so it has no API key parameter.
   */
  readonly hostedProviders: readonly ModelGatewayProvider[];
  readonly openAiApiKey?: string;
  readonly openRouterApiKey?: string;
  /** Operator model grants JSON (`DEPLOYMENTS_AI_MODEL_GRANTS_JSON`); empty means no grants. */
  readonly operatorModelGrantsJson: string;
}

export interface ModelRuntimeSecretValues {
  readonly "model-grants-json": string;
  readonly "openai-api-key"?: string;
  readonly "openrouter-api-key"?: string;
}

/**
 * Validates the model runtime parameter values: an API key for each hosted key-based provider, and
 * operator grants that only reference hosted providers. The grants are stored canonically.
 */
export function createModelRuntimeSecretValues(
  input: ModelRuntimeSecretInput,
): ModelRuntimeSecretValues {
  const hostedProviders = [...new Set(input.hostedProviders)];
  if (hostedProviders.length === 0) {
    throw new Error("At least one hosted model provider is required.");
  }
  const openAiApiKey = input.openAiApiKey?.trim() || undefined;
  const openRouterApiKey = input.openRouterApiKey?.trim() || undefined;
  if (hostedProviders.includes("openai") !== (openAiApiKey !== undefined)) {
    throw new Error("An OpenAI API key is required exactly when the openai provider is hosted.");
  }
  if (hostedProviders.includes("openrouter") !== (openRouterApiKey !== undefined)) {
    throw new Error(
      "An OpenRouter API key is required exactly when the openrouter provider is hosted.",
    );
  }
  const grants = parseModelOperatorGrantsJson(input.operatorModelGrantsJson);
  for (const [index, grant] of grants.entries()) {
    const providers = operatorGrantProviders(grant).filter((provider) =>
      grant.providers ? true : hostedProviders.includes(provider),
    );
    if (providers.length === 0) {
      throw new Error(`Model grant ${index} serves no hosted provider; list its providers.`);
    }
    const disabled = providers.find((provider) => !hostedProviders.includes(provider));
    if (disabled) {
      throw new Error(`Model grant ${index} references provider ${disabled}, which is not hosted.`);
    }
  }

  return {
    "model-grants-json": JSON.stringify(grants),
    ...(openAiApiKey ? { "openai-api-key": openAiApiKey } : {}),
    ...(openRouterApiKey ? { "openrouter-api-key": openRouterApiKey } : {}),
  };
}

export function awsSecretReferenceRegion(secretArns: Readonly<Record<string, string>>) {
  const regions = new Set(
    Object.values(secretArns).map((arn) => {
      const [arnPrefix, partition, service, region] = arn.split(":");
      if (
        arnPrefix !== "arn" ||
        !partition ||
        !["secretsmanager", "ssm"].includes(service ?? "") ||
        !region
      ) {
        throw new Error(`Invalid AWS secret reference ARN: ${arn}`);
      }
      return region;
    }),
  );
  if (regions.size !== 1) {
    throw new Error("Model runtime secret references must all be in one AWS region.");
  }
  const region = regions.values().next().value;
  if (!region) throw new Error("Model runtime secret reference ARNs are required.");
  return region;
}
