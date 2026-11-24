import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import {
  NonEmptyString,
  Timestamp,
  makeRecordSchema,
  mutableResourceFields,
  tenantScopeFields,
} from "../record-schema.ts";

const MODEL_CATALOG_RECORD_PROVIDERS = ["bedrock", "openai", "openrouter"] as const;
const MAX_MODEL_POLICY_MODELS = 256;
const MAX_MODEL_ID_LENGTH = 256;

const ModelId = NonEmptyString.pipe(Schema.check(Schema.isMaxLength(MAX_MODEL_ID_LENGTH)));
const PositiveTokenCount = Schema.Number.pipe(
  Schema.check(Schema.isInt(), Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(100_000_000)),
);
const UsdPerMillionTokens = Schema.Number.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(1_000_000)),
);

const ModelTokenPricesFields = {
  cacheReadUsdPerMillionTokens: Schema.optionalKey(UsdPerMillionTokens),
  cacheWriteUsdPerMillionTokens: Schema.optionalKey(UsdPerMillionTokens),
  inputUsdPerMillionTokens: UsdPerMillionTokens,
  outputUsdPerMillionTokens: UsdPerMillionTokens,
} as const;

export const ModelCatalogPricing = Schema.Struct({
  ...ModelTokenPricesFields,
  tiers: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ ...ModelTokenPricesFields, minPromptTokens: PositiveTokenCount }),
    ).pipe(Schema.check(Schema.isMaxLength(16))),
  ),
});

export const ModelCatalogCapabilities = Schema.Struct({
  imageInput: Schema.Boolean,
  reasoning: Schema.Boolean,
  structuredOutputs: Schema.Boolean,
  toolCalling: Schema.Boolean,
});

/**
 * One synchronized provider model. The catalog is platform-global (`GLOBAL#model-catalog-entry`),
 * keyed by the canonical platform model id. Entries missing from a later provider snapshot become
 * `retired` rather than deleted so releases pinned to them fail closed with a precise reason.
 */
export const ModelCatalogEntryRecord = makeRecordSchema("model-catalog-entry", {
  ...mutableResourceFields,
  capabilities: ModelCatalogCapabilities,
  contextWindowTokens: PositiveTokenCount,
  displayName: NonEmptyString.pipe(Schema.check(Schema.isMaxLength(200))),
  maximumOutputTokens: Schema.optionalKey(PositiveTokenCount),
  modelId: ModelId,
  pricing: ModelCatalogPricing,
  provider: Schema.Literals(MODEL_CATALOG_RECORD_PROVIDERS),
  providerModelId: ModelId,
  status: Schema.Literals(["active", "retired"]),
});

/**
 * An environment's model allowlist. At most one policy per environment is active, enforced by the
 * `environment:<environmentId>:model-policy` unique claim held while the policy is active.
 */
export const ModelPolicyRecord = makeRecordSchema("model-policy", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  archivedAt: Schema.optional(Timestamp),
  createdByPrincipalId: Ulid,
  description: Schema.optional(Schema.String.pipe(Schema.check(Schema.isMaxLength(4_096)))),
  id: Ulid,
  includeCuratedModels: Schema.Boolean,
  models: Schema.Array(ModelId).pipe(Schema.check(Schema.isMaxLength(MAX_MODEL_POLICY_MODELS))),
  name: NonEmptyString.pipe(Schema.check(Schema.isMaxLength(200))),
  status: Schema.Literals(["active", "archived"]),
});
