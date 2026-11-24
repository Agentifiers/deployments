import {
  MODEL_CAPABILITIES,
  MODEL_PROVIDERS,
  type ModelCatalogItem,
} from "@deployments-ai/api-contract";
import { PersistenceError, type ModelCatalogEntryData } from "@deployments-ai/db";
import {
  CURATED_MODEL_IDS,
  admitModel,
  isCuratedModelId,
  knownModelContextLimits,
  modelProviderForId,
  providerModelIdForModelId,
  type EffectiveModelPolicy,
  type OperatorModelGrants,
} from "@deployments-ai/model-gateway";
import { invalidQuery } from "./catalog-query-validation.ts";

type ModelProvider = (typeof MODEL_PROVIDERS)[number];
type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

export interface ModelListFilters {
  readonly allowed?: boolean;
  readonly capability?: ModelCapability;
  readonly curated?: boolean;
  readonly provider?: ModelProvider;
  readonly search?: string;
}

const CAPABILITY_FIELD: Readonly<
  Record<ModelCapability, keyof NonNullable<ModelCatalogItem["capabilities"]>>
> = {
  image_input: "imageInput",
  reasoning: "reasoning",
  structured_outputs: "structuredOutputs",
  tool_calling: "toolCalling",
};

const MAX_MODEL_ID_LENGTH = 256;
const MAX_SEARCH_LENGTH = 100;

function oneOf<const Value extends string>(
  searchParams: URLSearchParams,
  name: string,
  values: readonly Value[],
): Value | undefined {
  const raw = searchParams.get(name);
  if (raw === null) return undefined;
  const value = values.find((candidate) => candidate === raw);
  if (!value) throw invalidQuery(name, `one of ${values.join(", ")}`);
  return value;
}

function booleanFilter(searchParams: URLSearchParams, name: string) {
  const value = oneOf(searchParams, name, ["true", "false"]);
  return value === undefined ? undefined : value === "true";
}

/** Parses the listModels filters; unknown or out-of-range values are client errors. */
export function parseModelListFilters(searchParams: URLSearchParams): ModelListFilters {
  const provider = oneOf(searchParams, "provider", MODEL_PROVIDERS);
  const capability = oneOf(searchParams, "capability", MODEL_CAPABILITIES);
  const allowed = booleanFilter(searchParams, "allowed");
  const curated = booleanFilter(searchParams, "curated");
  const search = searchParams.get("search");
  if (search !== null && (search.length === 0 || search.length > MAX_SEARCH_LENGTH)) {
    throw invalidQuery("search", `1 through ${MAX_SEARCH_LENGTH} characters`);
  }
  return {
    ...(provider ? { provider } : {}),
    ...(capability ? { capability } : {}),
    ...(allowed === undefined ? {} : { allowed }),
    ...(curated === undefined ? {} : { curated }),
    ...(search === null ? {} : { search }),
  };
}

function cursorModelId(cursor: string) {
  const modelId = Buffer.from(cursor, "base64url").toString("utf8");
  if (
    modelId.length === 0 ||
    modelId.length > MAX_MODEL_ID_LENGTH ||
    Buffer.from(modelId, "utf8").toString("base64url") !== cursor
  ) {
    throw new PersistenceError(
      "invalid-input",
      "invalid_cursor",
      "The pagination cursor is invalid.",
    );
  }
  return modelId;
}

function catalogItem(
  entry: ModelCatalogEntryData,
  allowed: (modelId: string) => boolean,
): ModelCatalogItem {
  return {
    allowed: allowed(entry.modelId),
    capabilities: entry.capabilities,
    contextWindowTokens: entry.contextWindowTokens,
    curated: isCuratedModelId(entry.modelId),
    displayName: entry.displayName,
    ...(entry.maximumOutputTokens === undefined
      ? {}
      : { maximumOutputTokens: entry.maximumOutputTokens }),
    modelId: entry.modelId,
    pricing: entry.pricing,
    provider: entry.provider,
    providerModelId: entry.providerModelId,
  };
}

/**
 * Curated models without a synchronized catalog entry are described from code-owned context
 * limits; a curated model without authoritative limits cannot be listed truthfully and is omitted.
 */
function curatedItem(
  modelId: string,
  allowed: (modelId: string) => boolean,
): ModelCatalogItem | undefined {
  const limits = knownModelContextLimits(modelId);
  if (!limits) return undefined;
  return {
    allowed: allowed(modelId),
    contextWindowTokens: limits.contextWindowTokens,
    curated: true,
    displayName: modelId,
    ...(limits.maximumOutputTokens === undefined
      ? {}
      : { maximumOutputTokens: limits.maximumOutputTokens }),
    modelId,
    provider: modelProviderForId(modelId),
    providerModelId: providerModelIdForModelId(modelId),
  };
}

function matchesFilters(item: ModelCatalogItem, filters: ModelListFilters) {
  if (filters.provider !== undefined && item.provider !== filters.provider) return false;
  if (
    filters.capability !== undefined &&
    !item.capabilities?.[CAPABILITY_FIELD[filters.capability]]
  ) {
    return false;
  }
  if (filters.allowed !== undefined && item.allowed !== filters.allowed) return false;
  if (filters.curated !== undefined && item.curated !== filters.curated) return false;
  if (filters.search !== undefined) {
    const search = filters.search.toLowerCase();
    return (
      item.modelId.toLowerCase().includes(search) || item.displayName.toLowerCase().includes(search)
    );
  }
  return true;
}

/**
 * One page of the environment's model catalog: active synchronized entries plus the curated
 * models, each marked with whether publish would admit it under the environment's effective model
 * policy and the operator grants. Pages are ordered by model id and the cursor is the last
 * returned model id.
 */
export function modelCatalogPage(input: {
  readonly cursor?: string;
  readonly entries: readonly ModelCatalogEntryData[];
  readonly filters: ModelListFilters;
  readonly limit: number;
  readonly operatorGrants?: OperatorModelGrants;
  readonly policy: EffectiveModelPolicy;
}): { readonly items: readonly ModelCatalogItem[]; readonly nextCursor: string | null } {
  const after = input.cursor === undefined ? undefined : cursorModelId(input.cursor);
  const active = new Map(
    input.entries
      .filter((entry) => entry.status === "active")
      .map((entry) => [entry.modelId, entry] as const),
  );
  const membership = { has: (modelId: string) => active.has(modelId) };
  const allowed = (modelId: string) =>
    admitModel(modelId, input.policy, membership, input.operatorGrants).allowed;
  const items = [
    ...[...active.values()].map((entry) => catalogItem(entry, allowed)),
    ...CURATED_MODEL_IDS.filter((modelId) => !active.has(modelId)).flatMap(
      (modelId) => curatedItem(modelId, allowed) ?? [],
    ),
  ]
    .filter(
      (item) =>
        (after === undefined || item.modelId > after) && matchesFilters(item, input.filters),
    )
    .toSorted((left, right) =>
      left.modelId < right.modelId ? -1 : left.modelId > right.modelId ? 1 : 0,
    );
  const page = items.slice(0, input.limit);
  return {
    items: page,
    nextCursor:
      items.length > input.limit
        ? Buffer.from(page.at(-1)!.modelId, "utf8").toString("base64url")
        : null,
  };
}
