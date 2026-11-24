import {
  MODEL_CATALOG_PROVIDERS,
  type ModelCatalogProvider,
  type ModelCatalogRuntimeEntries,
  type ModelCatalogRuntimeEntry,
} from "./model-catalog.ts";
import {
  imageInputSupport,
  type ImageInputCatalogEntry,
  type ImageInputSupport,
} from "./image-input.ts";
import { modelProviderForId, normalizeModelId } from "./routing.ts";
import {
  BEDROCK_MODEL_PREFIX,
  DEFAULT_BIFROST_BEDROCK_ALLOWED_MODELS,
  DEFAULT_BIFROST_OPENAI_ALLOWED_MODELS,
  DEFAULT_BIFROST_OPENROUTER_ALLOWED_MODELS,
  OPENAI_MODEL_PREFIX,
  OPENROUTER_MODEL_PREFIX,
  OPENROUTER_UNPREFIXED_MODEL_IDS,
  type ModelGatewayRouteScope,
} from "./types.ts";
import { operatorGrantAllowsModel, type ModelOperatorGrant } from "./operator-grants.ts";

/**
 * The code-owned curated models. They are the out-of-the-box policy for an environment without a
 * model policy and they never require a catalog entry.
 */
export const CURATED_MODEL_IDS: readonly string[] = Object.freeze([
  ...DEFAULT_BIFROST_OPENAI_ALLOWED_MODELS.map((model) => `${OPENAI_MODEL_PREFIX}${model}`),
  ...DEFAULT_BIFROST_OPENROUTER_ALLOWED_MODELS.map((model) => `${OPENROUTER_MODEL_PREFIX}${model}`),
  ...DEFAULT_BIFROST_BEDROCK_ALLOWED_MODELS.map((model) => `${BEDROCK_MODEL_PREFIX}${model}`),
]);

const CURATED_MODEL_ID_SET = new Set(CURATED_MODEL_IDS.map((modelId) => modelId.toLowerCase()));

/** Provider prefixes a manifest or policy may name explicitly. */
export const MODEL_ID_PROVIDER_PREFIXES = ["bedrock", "openai", "openrouter"] as const;

export const MAX_MODEL_POLICY_ENTRIES = 256;
export const MAX_MODEL_POLICY_ENTRY_LENGTH = 256;

export interface ModelPolicyRules {
  /** Whether the code-owned curated models remain allowed alongside `models`. */
  readonly includeCuratedModels: boolean;
  /** Canonical platform model ids or provider-wide entries such as `openrouter/*`. */
  readonly models: readonly string[];
}

export type EffectiveModelPolicy =
  | { readonly source: "curated-defaults" }
  | {
      readonly modelPolicyId: string;
      readonly rules: ModelPolicyRules;
      readonly source: "model-policy";
    };

export const CURATED_DEFAULT_MODEL_POLICY: EffectiveModelPolicy = Object.freeze({
  source: "curated-defaults",
});

export type ModelPolicyEntry =
  | { readonly kind: "model"; readonly modelId: string }
  | { readonly kind: "provider"; readonly provider: ModelCatalogProvider };

export type ModelAdmissionFailureReason =
  | "invalid_model_id"
  | "model_not_allowed_by_environment_policy"
  | "model_not_in_catalog"
  | "unknown_model_provider";

/**
 * Why a model is admitted: `environment-policy` when the environment's model policy (or the
 * curated defaults) and the catalog admit it; `operator-grant` when only an operator grant for the
 * agent's scope admits it.
 */
export type ModelAdmissionBasis = "environment-policy" | "operator-grant";

export type ModelAdmission =
  | {
      readonly allowed: true;
      readonly basis: ModelAdmissionBasis;
      readonly curated: boolean;
      readonly modelId: string;
    }
  | {
      readonly allowed: false;
      readonly message: string;
      readonly modelId: string;
      readonly reason: ModelAdmissionFailureReason;
    };

/** Catalog membership for non-curated models; only active synchronized entries count. */
export interface ModelCatalogMembership {
  readonly has: (modelId: string) => boolean;
}

/**
 * The operator grants and the scope an agent's model calls are admitted under (`agentId` = the
 * agent definition id, `organizationId`, `workspaceId`).
 */
export interface OperatorModelGrants {
  readonly grants: readonly ModelOperatorGrant[];
  readonly scope: ModelGatewayRouteScope;
}

/**
 * The grant scope of an agent's model calls (its run id never affects grant selection): the
 * agent definition id as `agentId`, the organization, and the workspace when the run has one.
 */
export function agentModelGrantScope(input: {
  readonly agentDefinitionId?: string | undefined;
  readonly organizationId: string;
  readonly workspaceId?: string | undefined;
}): ModelGatewayRouteScope {
  return {
    ...(input.agentDefinitionId ? { agentId: input.agentDefinitionId } : {}),
    organizationId: input.organizationId,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
  };
}

export class ModelPolicyEntryError extends TypeError {
  constructor(
    readonly entry: string,
    message: string,
  ) {
    super(message);
    this.name = "ModelPolicyEntryError";
  }
}

export function isCuratedModelId(modelId: string) {
  return CURATED_MODEL_ID_SET.has(modelId.toLowerCase());
}

function unknownProviderPrefix(modelId: string) {
  const trimmed = modelId.trim();
  const slash = trimmed.indexOf("/");
  if (slash < 0) return undefined;
  const prefix = trimmed.slice(0, slash).toLowerCase();
  if ((MODEL_ID_PROVIDER_PREFIXES as readonly string[]).includes(prefix)) return undefined;
  // Legacy curated OpenRouter ids may omit the `openrouter/` prefix.
  if (OPENROUTER_UNPREFIXED_MODEL_IDS.has(trimmed.toLowerCase())) return undefined;
  return prefix;
}

/**
 * Parses one model-policy entry. Exact entries must already be canonical platform ids so a policy
 * reads exactly as the gateway routes it; provider-wide entries are limited to the synchronized
 * hosted catalogs.
 */
export function parseModelPolicyEntry(entry: string): ModelPolicyEntry {
  const trimmed = entry.trim();
  if (!trimmed || trimmed.length > MAX_MODEL_POLICY_ENTRY_LENGTH || trimmed !== entry) {
    throw new ModelPolicyEntryError(
      entry,
      `Model policy entries must be trimmed, non-empty, and at most ${MAX_MODEL_POLICY_ENTRY_LENGTH} characters.`,
    );
  }
  const unknownPrefix = unknownProviderPrefix(trimmed);
  if (unknownPrefix || !trimmed.includes("/")) {
    throw new ModelPolicyEntryError(
      entry,
      `Model policy entry ${entry} must start with a supported provider prefix (${MODEL_ID_PROVIDER_PREFIXES.map((prefix) => `${prefix}/`).join(", ")}).`,
    );
  }
  if (trimmed.endsWith("/*")) {
    const provider = trimmed.slice(0, -2).toLowerCase();
    if (!(MODEL_CATALOG_PROVIDERS as readonly string[]).includes(provider)) {
      throw new ModelPolicyEntryError(
        entry,
        `Provider-wide model policy entries are supported only for ${MODEL_CATALOG_PROVIDERS.map((name) => `${name}/*`).join(", ")}.`,
      );
    }
    return { kind: "provider", provider: provider as ModelCatalogProvider };
  }
  if (trimmed.includes("*")) {
    throw new ModelPolicyEntryError(
      entry,
      `Model policy entry ${entry} may use * only as a whole provider suffix.`,
    );
  }
  let modelId: string;
  try {
    modelId = normalizeModelId(trimmed);
  } catch (cause) {
    throw new ModelPolicyEntryError(
      entry,
      cause instanceof Error ? cause.message : `Model policy entry ${entry} is invalid.`,
    );
  }
  if (modelId !== trimmed) {
    throw new ModelPolicyEntryError(
      entry,
      `Model policy entry ${entry} must use the canonical platform model id ${modelId}.`,
    );
  }
  return { kind: "model", modelId };
}

/**
 * Validates a whole policy rule set: every entry parses, no entry repeats, and every exact
 * non-curated model exists in the synchronized catalog. Returns the entries that failed.
 */
export function modelPolicyRuleIssues(
  rules: ModelPolicyRules,
  catalog: ModelCatalogMembership,
): readonly { readonly entry: string; readonly message: string }[] {
  const issues: { readonly entry: string; readonly message: string }[] = [];
  if (rules.models.length > MAX_MODEL_POLICY_ENTRIES) {
    issues.push({
      entry: "",
      message: `Model policies support at most ${MAX_MODEL_POLICY_ENTRIES} entries.`,
    });
  }
  if (!rules.includeCuratedModels && rules.models.length === 0) {
    issues.push({
      entry: "",
      message: "A model policy that excludes the curated models must allow at least one model.",
    });
  }
  const seen = new Set<string>();
  for (const entry of rules.models) {
    let parsed: ModelPolicyEntry;
    try {
      parsed = parseModelPolicyEntry(entry);
    } catch (cause) {
      issues.push({
        entry,
        message: cause instanceof Error ? cause.message : String(cause),
      });
      continue;
    }
    const identity = (
      parsed.kind === "model" ? parsed.modelId : `${parsed.provider}/*`
    ).toLowerCase();
    if (seen.has(identity)) {
      issues.push({ entry, message: `Model policy entry ${entry} is repeated.` });
      continue;
    }
    seen.add(identity);
    if (
      parsed.kind === "model" &&
      !isCuratedModelId(parsed.modelId) &&
      !catalog.has(parsed.modelId)
    ) {
      issues.push({
        entry,
        message: `Model ${parsed.modelId} is not in the platform model catalog.`,
      });
    }
  }
  return issues;
}

function policyEntryAllows(entries: readonly string[], modelId: string) {
  const provider = modelProviderForId(modelId);
  const normalized = modelId.toLowerCase();
  return entries.some((entry) => {
    let parsed: ModelPolicyEntry;
    try {
      parsed = parseModelPolicyEntry(entry);
    } catch {
      return false;
    }
    return parsed.kind === "model"
      ? parsed.modelId.toLowerCase() === normalized
      : parsed.provider === provider;
  });
}

/**
 * Decides whether an environment may run a model. The decision is made on the canonical platform
 * id. The environment policy (or the curated defaults) admits a model, and non-curated models must
 * also be active in the synchronized catalog because the runtime packs context and meters cost
 * from catalog metadata. A model the policy does not admit is still admitted when the operator
 * grant selected for the agent's scope lists it explicitly.
 */
export function admitModel(
  requestedModelId: string,
  policy: EffectiveModelPolicy,
  catalog: ModelCatalogMembership,
  operatorGrants?: OperatorModelGrants,
): ModelAdmission {
  const unknownPrefix = unknownProviderPrefix(requestedModelId);
  if (unknownPrefix) {
    return {
      allowed: false,
      message: `Model ${requestedModelId} uses unknown provider prefix ${unknownPrefix}/; use one of ${MODEL_ID_PROVIDER_PREFIXES.map((prefix) => `${prefix}/`).join(", ")} (for example openrouter/${requestedModelId.trim()}).`,
      modelId: requestedModelId,
      reason: "unknown_model_provider",
    };
  }
  let modelId: string;
  try {
    modelId = normalizeModelId(requestedModelId);
  } catch (cause) {
    return {
      allowed: false,
      message: cause instanceof Error ? cause.message : `Model ${requestedModelId} is invalid.`,
      modelId: requestedModelId,
      reason: "invalid_model_id",
    };
  }
  const curated = isCuratedModelId(modelId);
  const policyAllows =
    policy.source === "curated-defaults"
      ? curated
      : (curated && policy.rules.includeCuratedModels) ||
        policyEntryAllows(policy.rules.models, modelId);
  const cataloged = curated || catalog.has(modelId);
  if (policyAllows && cataloged) {
    return { allowed: true, basis: "environment-policy", curated, modelId };
  }
  if (
    operatorGrants &&
    operatorGrantAllowsModel(operatorGrants.grants, operatorGrants.scope, modelId)
  ) {
    return { allowed: true, basis: "operator-grant", curated, modelId };
  }
  if (!policyAllows) {
    return {
      allowed: false,
      message:
        policy.source === "curated-defaults"
          ? `Model ${modelId} is not one of the curated models; create an environment model policy that allows it.`
          : `Model ${modelId} is not allowed by environment model policy ${policy.modelPolicyId}.`,
      modelId,
      reason: "model_not_allowed_by_environment_policy",
    };
  }
  return {
    allowed: false,
    message: `Model ${modelId} is not an active entry in the platform model catalog.`,
    modelId,
    reason: "model_not_in_catalog",
  };
}

/** The admitted canonical model ids, in reference order without repeats. */
export function admittedModelIds(admissions: readonly ModelAdmission[]): readonly string[] {
  return [
    ...new Set(admissions.flatMap((admission) => (admission.allowed ? [admission.modelId] : []))),
  ];
}

/** The canonical ids a model reference could resolve to, for prefetching catalog entries. */
export function catalogLookupModelIds(requestedModelIds: readonly string[]): readonly string[] {
  return [
    ...new Set(
      requestedModelIds.flatMap((requestedModelId) => {
        if (unknownProviderPrefix(requestedModelId)) return [];
        try {
          return [normalizeModelId(requestedModelId)];
        } catch {
          return [];
        }
      }),
    ),
  ];
}

/** The persisted fields of an environment model policy that decide admission. */
export interface ModelPolicySnapshot {
  readonly id: string;
  readonly includeCuratedModels: boolean;
  readonly models: readonly string[];
}

/** An environment without an active model policy runs the curated defaults. */
export function effectiveModelPolicy(
  activePolicy: ModelPolicySnapshot | undefined,
): EffectiveModelPolicy {
  return activePolicy
    ? {
        modelPolicyId: activePolicy.id,
        rules: {
          includeCuratedModels: activePolicy.includeCuratedModels,
          models: activePolicy.models,
        },
        source: "model-policy",
      }
    : CURATED_DEFAULT_MODEL_POLICY;
}

/** A persisted catalog entry as the admission check needs it. */
export interface ModelCatalogEntrySnapshot
  extends ModelCatalogRuntimeEntry, ImageInputCatalogEntry {
  readonly modelId: string;
}

export interface ModelReferenceAdmission {
  readonly admissions: readonly ModelAdmission[];
  readonly imageInput: ReadonlyMap<string, ImageInputSupport>;
  /** Runtime metadata for every admitted non-curated model, keyed by canonical model id. */
  readonly modelCatalog: ModelCatalogRuntimeEntries;
}

/**
 * Admits a manifest's model references (primary first, then fallbacks) against an environment
 * policy, the catalog entries loaded for `catalogLookupModelIds(requestedModelIds)`, and the
 * operator grants applicable to the agent.
 */
export function admitModelReferences(
  requestedModelIds: readonly string[],
  policy: EffectiveModelPolicy,
  catalogEntries: ReadonlyMap<string, ModelCatalogEntrySnapshot>,
  operatorGrants?: OperatorModelGrants,
): ModelReferenceAdmission {
  const membership: ModelCatalogMembership = {
    has: (modelId) => catalogEntries.get(modelId)?.status === "active",
  };
  const admissions = requestedModelIds.map((modelId) =>
    admitModel(modelId, policy, membership, operatorGrants),
  );
  const modelCatalog: Record<string, ModelCatalogRuntimeEntry> = {};
  for (const admission of admissions) {
    if (!admission.allowed || admission.curated) continue;
    const entry = catalogEntries.get(admission.modelId);
    if (entry?.status !== "active") continue;
    modelCatalog[admission.modelId] = {
      contextWindowTokens: entry.contextWindowTokens,
      ...(entry.maximumOutputTokens !== undefined
        ? { maximumOutputTokens: entry.maximumOutputTokens }
        : {}),
      pricing: entry.pricing,
    };
  }
  return {
    admissions,
    imageInput: new Map(
      requestedModelIds.map((modelId) => [modelId, imageInputSupport(modelId, catalogEntries)]),
    ),
    modelCatalog,
  };
}
