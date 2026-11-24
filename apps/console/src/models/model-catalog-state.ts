import {
  MODEL_CAPABILITIES,
  MODEL_PROVIDERS,
  type ModelCatalogItem,
} from "@deployments-ai/api-contract/models";
import { oneOf } from "../observability/range.ts";

export type ModelProvider = (typeof MODEL_PROVIDERS)[number];
export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

export interface ModelSearch {
  readonly provider?: ModelProvider;
  readonly capability?: ModelCapability;
  readonly allowed?: boolean;
  readonly curated?: boolean;
  readonly search?: string;
}

export const PROVIDER_LABELS: Readonly<Record<ModelProvider, string>> = {
  bedrock: "Bedrock",
  openai: "OpenAI",
  openrouter: "OpenRouter",
};

export const CAPABILITY_LABELS: Readonly<Record<ModelCapability, string>> = {
  image_input: "Image input",
  reasoning: "Reasoning",
  structured_outputs: "Structured outputs",
  tool_calling: "Tool calling",
};

const CAPABILITY_FIELDS: Readonly<
  Record<ModelCapability, keyof NonNullable<ModelCatalogItem["capabilities"]>>
> = {
  image_input: "imageInput",
  reasoning: "reasoning",
  structured_outputs: "structuredOutputs",
  tool_calling: "toolCalling",
};

const MAX_SEARCH_LENGTH = 100;

function flag(value: unknown): boolean | undefined {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return undefined;
}

export function parseModelSearch(search: Readonly<Record<string, unknown>>): ModelSearch {
  const provider = oneOf(MODEL_PROVIDERS, search.provider);
  const capability = oneOf(MODEL_CAPABILITIES, search.capability);
  const allowed = flag(search.allowed);
  const curated = flag(search.curated);
  const text =
    typeof search.search === "string" ? search.search.trim().slice(0, MAX_SEARCH_LENGTH) : "";
  return {
    ...(provider ? { provider } : {}),
    ...(capability ? { capability } : {}),
    ...(allowed === undefined ? {} : { allowed }),
    ...(curated === undefined ? {} : { curated }),
    ...(text ? { search: text } : {}),
  };
}

export function modelCapabilities(item: ModelCatalogItem): readonly ModelCapability[] {
  return MODEL_CAPABILITIES.filter(
    (capability) => item.capabilities?.[CAPABILITY_FIELDS[capability]],
  );
}

const USD = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 4,
  minimumFractionDigits: 2,
  style: "currency",
});

export function formatModelPrice(item: ModelCatalogItem): string | undefined {
  return item.pricing
    ? `${USD.format(item.pricing.inputUsdPerMillionTokens)} / ${USD.format(item.pricing.outputUsdPerMillionTokens)}`
    : undefined;
}
