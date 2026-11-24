import { Schema } from "effect";
import { PublicId, ResourceDescription, ResourceName, Timestamp } from "./primitives.ts";

export const MODEL_PROVIDERS = ["bedrock", "openai", "openrouter"] as const;
export const MODEL_CAPABILITIES = [
  "tool_calling",
  "structured_outputs",
  "image_input",
  "reasoning",
] as const;
const MAX_MODEL_POLICY_MODELS = 256;

const Version = Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)));
const TokenCount = Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThan(0)));
const UsdPerMillionTokens = Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)));
const ModelId = Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(256)));
const ModelPolicyEntry = Schema.String.pipe(
  Schema.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(256)),
);
const ModelPolicyEntries = Schema.Array(ModelPolicyEntry).pipe(
  Schema.check(Schema.isMaxLength(MAX_MODEL_POLICY_MODELS)),
);

export const ModelProvider = Schema.Literals(MODEL_PROVIDERS);
export const ModelCapability = Schema.Literals(MODEL_CAPABILITIES);

const ModelTokenPricesFields = {
  cacheReadUsdPerMillionTokens: Schema.optional(UsdPerMillionTokens),
  cacheWriteUsdPerMillionTokens: Schema.optional(UsdPerMillionTokens),
  inputUsdPerMillionTokens: UsdPerMillionTokens,
  outputUsdPerMillionTokens: UsdPerMillionTokens,
} as const;

export const ModelPricing = Schema.Struct({
  ...ModelTokenPricesFields,
  tiers: Schema.optional(
    Schema.Array(Schema.Struct({ ...ModelTokenPricesFields, minPromptTokens: TokenCount })),
  ),
});

export const ModelCapabilities = Schema.Struct({
  imageInput: Schema.Boolean,
  reasoning: Schema.Boolean,
  structuredOutputs: Schema.Boolean,
  toolCalling: Schema.Boolean,
});

export const ModelCatalogItem = Schema.Struct({
  allowed: Schema.Boolean,
  capabilities: Schema.optional(ModelCapabilities),
  contextWindowTokens: TokenCount,
  curated: Schema.Boolean,
  displayName: Schema.String,
  maximumOutputTokens: Schema.optional(TokenCount),
  modelId: ModelId,
  pricing: Schema.optional(ModelPricing),
  provider: ModelProvider,
  providerModelId: ModelId,
});

export const EffectiveModelPolicyResponse = Schema.Struct({
  modelPolicyId: Schema.optional(PublicId),
  source: Schema.Literals(["curated_defaults", "model_policy"]),
});

export const ListModelsResponse = Schema.Struct({
  items: Schema.Array(ModelCatalogItem),
  nextCursor: Schema.NullOr(Schema.String),
  policy: EffectiveModelPolicyResponse,
});

export const ModelPolicyResponse = Schema.Struct({
  archivedAt: Schema.optional(Timestamp),
  createdAt: Timestamp,
  description: Schema.optional(Schema.String),
  id: PublicId,
  includeCuratedModels: Schema.Boolean,
  models: Schema.Array(Schema.String),
  name: Schema.String,
  status: Schema.Literals(["active", "archived"]),
  updatedAt: Timestamp,
  version: Version,
});

export const ListModelPoliciesResponse = Schema.Struct({
  items: Schema.Array(ModelPolicyResponse),
  nextCursor: Schema.NullOr(Schema.String),
});

export const CreateModelPolicyRequest = Schema.Struct({
  description: Schema.optional(ResourceDescription),
  includeCuratedModels: Schema.Boolean,
  models: ModelPolicyEntries,
  name: ResourceName,
});

export const UpdateModelPolicyRequest = Schema.Struct({
  description: Schema.optional(ResourceDescription),
  expectedVersion: Version,
  includeCuratedModels: Schema.optional(Schema.Boolean),
  models: Schema.optional(ModelPolicyEntries),
  name: Schema.optional(ResourceName),
});

export const ArchiveModelPolicyRequest = Schema.Struct({
  expectedVersion: Version,
});

export const MODEL_API_SCHEMAS = {
  ArchiveModelPolicyRequest,
  CreateModelPolicyRequest,
  EffectiveModelPolicyResponse,
  ListModelPoliciesResponse,
  ListModelsResponse,
  ModelCapabilities,
  ModelCatalogItem,
  ModelPolicyResponse,
  ModelPricing,
  UpdateModelPolicyRequest,
} as const;

export type ModelCatalogItem = typeof ModelCatalogItem.Type;
export type ListModelsResponse = typeof ListModelsResponse.Type;
export type ModelPolicyResponse = typeof ModelPolicyResponse.Type;
export type ListModelPoliciesResponse = typeof ListModelPoliciesResponse.Type;
export type CreateModelPolicyRequest = typeof CreateModelPolicyRequest.Type;
export type UpdateModelPolicyRequest = typeof UpdateModelPolicyRequest.Type;
export type ArchiveModelPolicyRequest = typeof ArchiveModelPolicyRequest.Type;
