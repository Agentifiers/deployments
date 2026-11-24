import type { ModelCatalogCapabilities } from "./model-catalog.ts";
import { normalizeModelId } from "./routing.ts";
import type {
  BEDROCK_MODEL_PREFIX,
  DEFAULT_BIFROST_BEDROCK_ALLOWED_MODELS,
  DEFAULT_BIFROST_OPENAI_ALLOWED_MODELS,
  DEFAULT_BIFROST_OPENROUTER_ALLOWED_MODELS,
  OPENAI_MODEL_PREFIX,
  OPENROUTER_MODEL_PREFIX,
} from "./types.ts";

export type ImageInputSupport = "supported" | "unsupported" | "unknown";

type CuratedModelId =
  | `${typeof OPENAI_MODEL_PREFIX}${(typeof DEFAULT_BIFROST_OPENAI_ALLOWED_MODELS)[number]}`
  | `${typeof OPENROUTER_MODEL_PREFIX}${(typeof DEFAULT_BIFROST_OPENROUTER_ALLOWED_MODELS)[number]}`
  | `${typeof BEDROCK_MODEL_PREFIX}${(typeof DEFAULT_BIFROST_BEDROCK_ALLOWED_MODELS)[number]}`;

const CURATED_IMAGE_INPUT = {
  "bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0": true,
  "bedrock/global.cohere.embed-v4:0": false,
  "openai/gpt-4.1": true,
  "openai/gpt-4o": true,
  "openai/gpt-4o-mini": true,
  "openai/gpt-5.2": true,
  "openai/text-embedding-3-small": false,
  "openrouter/anthropic/claude-opus-5.5": true,
  "openrouter/openai/gpt-4o": true,
  "openrouter/openai/text-embedding-3-small": false,
  "openrouter/qwen/qwen3.7-plus": true,
  "openrouter/xiaomi/mimo-v2.5": true,
  "openrouter/z-ai/glm-5.2": false,
  "openrouter/z-ai/glm-5.3-flash": true,
} as const satisfies Record<CuratedModelId, boolean>;

const CURATED_IMAGE_INPUT_BY_ID: ReadonlyMap<string, boolean> = new Map(
  Object.entries(CURATED_IMAGE_INPUT),
);

export interface ImageInputCatalogEntry {
  readonly capabilities: Pick<ModelCatalogCapabilities, "imageInput">;
  readonly status: "active" | "retired";
}

export function imageInputSupport(
  requestedModelId: string,
  catalogEntries: ReadonlyMap<string, ImageInputCatalogEntry>,
): ImageInputSupport {
  let modelId: string;
  try {
    modelId = normalizeModelId(requestedModelId);
  } catch {
    return "unknown";
  }
  const entry = catalogEntries.get(modelId);
  const supported =
    entry?.status === "active"
      ? entry.capabilities.imageInput
      : CURATED_IMAGE_INPUT_BY_ID.get(modelId.toLowerCase());
  if (supported === undefined) return "unknown";
  return supported ? "supported" : "unsupported";
}

export type ImageInputModelChain =
  | { readonly kind: "accepted"; readonly modelFallbackIds: readonly string[] }
  | {
      readonly kind: "primary-unaccepted";
      readonly support: Exclude<ImageInputSupport, "supported">;
    };

export function imageInputModelChain(
  chain: { readonly modelFallbackIds: readonly string[]; readonly modelId: string },
  supportOf: ReadonlyMap<string, ImageInputSupport>,
): ImageInputModelChain {
  const primary = supportOf.get(chain.modelId) ?? "unknown";
  if (primary !== "supported") return { kind: "primary-unaccepted", support: primary };
  return {
    kind: "accepted",
    modelFallbackIds: chain.modelFallbackIds.filter(
      (modelId) => supportOf.get(modelId) === "supported",
    ),
  };
}
