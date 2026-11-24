import { MODEL_CAPABILITIES, MODEL_PROVIDERS } from "@deployments-ai/api-contract/models";
import type { PublicRouteName } from "@deployments-ai/api-contract/product";
import { decodePublicRequest, decodePublicResponse } from "@deployments-ai/api-contract/validation";
import { PlatformApiError, PlatformRequestError, type PlatformRequest } from "./index.ts";
import {
  MOCK_MODEL_CATALOG,
  MOCK_MODEL_PROVIDER_WILDCARDS,
  mockModelCatalogHas,
  type MockModelCapabilities,
  type MockModelCatalogEntry,
} from "./model-mock-catalog.ts";
import {
  canonicalValue,
  nextPublicId,
  page,
  scope,
  validateRouteScope,
  type StoredModelPolicy,
  type TenancyMockState,
} from "./tenancy-mock.ts";

type ModelRouteName = Extract<
  PublicRouteName,
  | "archiveModelPolicy"
  | "createModelPolicy"
  | "getModelPolicy"
  | "listModelPolicies"
  | "listModels"
  | "updateModelPolicy"
>;

type ModelMockResult =
  | { readonly matched: false }
  | { readonly data: unknown; readonly matched: true };

const POLICY_PATH = /^\/v1\/model-policies\/([^/]+)$/u;
const CAPABILITY_FIELDS: Readonly<
  Record<(typeof MODEL_CAPABILITIES)[number], keyof MockModelCapabilities>
> = {
  image_input: "imageInput",
  reasoning: "reasoning",
  structured_outputs: "structuredOutputs",
  tool_calling: "toolCalling",
};
const MODELS_QUERY_FIELDS = new Set([
  "allowed",
  "capability",
  "cursor",
  "curated",
  "limit",
  "provider",
  "search",
]);
const POLICIES_QUERY_FIELDS = new Set(["cursor", "limit"]);

function modelRoute(
  request: PlatformRequest,
): { readonly id?: string; readonly name: ModelRouteName } | undefined {
  if (request.path === "/v1/models") {
    if (request.method !== "GET") {
      throw new PlatformRequestError(`${request.method} is not supported for /v1/models.`);
    }
    return { name: "listModels" };
  }
  if (request.path === "/v1/model-policies") {
    if (request.method === "GET") return { name: "listModelPolicies" };
    if (request.method === "POST") return { name: "createModelPolicy" };
    throw new PlatformRequestError(`${request.method} is not supported for /v1/model-policies.`);
  }
  const target = POLICY_PATH.exec(request.path)?.[1];
  if (!target) return undefined;
  const id = decodeURIComponent(target);
  if (request.method === "GET") return { id, name: "getModelPolicy" };
  if (request.method === "PATCH") return { id, name: "updateModelPolicy" };
  if (request.method === "DELETE") return { id, name: "archiveModelPolicy" };
  throw new PlatformRequestError(`${request.method} is not supported for ${request.path}.`);
}

function problem(status: number, code: string, detail: string): PlatformApiError {
  const titles: Readonly<Record<number, string>> = {
    404: "Not Found",
    409: "Conflict",
    422: "Unprocessable Content",
  };
  return new PlatformApiError({ code, detail, status, title: titles[status] ?? "Error" });
}

function queryRecord(
  request: PlatformRequest,
  allowed: ReadonlySet<string>,
): Readonly<Record<string, boolean | number | string>> {
  const values: Record<string, boolean | number | string> = {};
  for (const [field, value] of Object.entries(request.query ?? {})) {
    if (value === undefined) continue;
    if (!allowed.has(field)) {
      throw new PlatformRequestError(`Unsupported query parameter ${field}.`);
    }
    values[field] = value;
  }
  return values;
}

function queryLimit(value: boolean | number | string | undefined): number {
  if (value === undefined) return 50;
  const limit = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new PlatformRequestError("limit must be an integer between 1 and 100.");
  }
  return limit;
}

function queryBoolean(field: string, value: boolean | number | string | undefined) {
  if (value === undefined || typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new PlatformRequestError(`${field} must be true or false.`);
}

function queryMember<const Member extends string>(
  field: string,
  value: boolean | number | string | undefined,
  members: readonly Member[],
): Member | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && (members as readonly string[]).includes(value)) {
    return value as Member;
  }
  throw new PlatformRequestError(`${field} must be one of ${members.join(", ")}.`);
}
function encodeModelCursor(modelId: string): string {
  return globalThis
    .btoa(String.fromCharCode(...new TextEncoder().encode(modelId)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function decodeModelCursor(value: boolean | number | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let modelId = "";
  if (typeof value === "string" && /^[A-Za-z0-9_-]+$/u.test(value)) {
    try {
      const binary = globalThis.atob(value.replaceAll("-", "+").replaceAll("_", "/"));
      modelId = new TextDecoder("utf-8", { fatal: true }).decode(
        Uint8Array.from(binary, (character) => character.charCodeAt(0)),
      );
    } catch {
      // Fall through to the shared invalid-cursor error.
    }
  }
  if (!/^[a-z]+\/\S+$/u.test(modelId) || encodeModelCursor(modelId) !== value) {
    throw new PlatformRequestError("The pagination cursor is invalid.");
  }
  return modelId;
}

function activePolicy(state: TenancyMockState, environmentId: string) {
  return [...state.modelPolicies.values()].find(
    (policy) => policy.environmentId === environmentId && policy.status === "active",
  );
}

function modelAllowed(entry: MockModelCatalogEntry, policy: StoredModelPolicy | undefined) {
  if (!policy) return entry.curated;
  if (policy.includeCuratedModels && entry.curated) return true;
  return policy.models.some((rule) => rule === entry.modelId || rule === `${entry.provider}/*`);
}

function listModels(request: PlatformRequest, state: TenancyMockState) {
  const query = queryRecord(request, MODELS_QUERY_FIELDS);
  const limit = queryLimit(query.limit);
  const after = decodeModelCursor(query.cursor);
  const provider = queryMember("provider", query.provider, MODEL_PROVIDERS);
  const capability = queryMember("capability", query.capability, MODEL_CAPABILITIES);
  const allowed = queryBoolean("allowed", query.allowed);
  const curated = queryBoolean("curated", query.curated);
  if (
    query.search !== undefined &&
    (typeof query.search !== "string" || query.search.length < 1 || query.search.length > 100)
  ) {
    throw new PlatformRequestError("search must contain between 1 and 100 characters.");
  }
  const search = query.search === undefined ? undefined : String(query.search).toLowerCase();
  const policy = activePolicy(state, scope(request).environmentId);
  const matching = MOCK_MODEL_CATALOG.map(({ curated: isCurated, ...entry }) => ({
    ...entry,
    allowed: modelAllowed({ ...entry, curated: isCurated }, policy),
    curated: isCurated,
  })).filter(
    (item) =>
      (after === undefined || item.modelId > after) &&
      (provider === undefined || item.provider === provider) &&
      (capability === undefined || item.capabilities?.[CAPABILITY_FIELDS[capability]] === true) &&
      (allowed === undefined || item.allowed === allowed) &&
      (curated === undefined || item.curated === curated) &&
      (search === undefined ||
        item.modelId.toLowerCase().includes(search) ||
        item.displayName.toLowerCase().includes(search)),
  );
  const items = matching.slice(0, limit);
  return {
    items,
    nextCursor: matching.length > limit ? encodeModelCursor(items.at(-1)!.modelId) : null,
    policy: policy
      ? { modelPolicyId: policy.id, source: "model_policy" }
      : { source: "curated_defaults" },
  };
}

function assertPolicyRules(models: readonly string[]) {
  const issues = models.flatMap((entry) => {
    if ((MOCK_MODEL_PROVIDER_WILDCARDS as readonly string[]).includes(entry)) return [];
    if (entry.includes("*")) {
      return [`${entry}: Provider-wide entries are limited to openai/* and openrouter/*.`];
    }
    return mockModelCatalogHas(entry)
      ? []
      : [`${entry}: The model is not in the synchronized model catalog.`];
  });
  if (issues.length > 0) throw problem(422, "invalid_model_policy", issues.join("\n"));
}

function policyResponse({ environmentId: _environmentId, ...policy }: StoredModelPolicy) {
  return policy;
}

function requirePolicy(state: TenancyMockState, environmentId: string, id: string) {
  const policy = state.modelPolicies.get(id);
  if (!policy || policy.environmentId !== environmentId) {
    throw problem(404, "resource_not_found", "The model policy was not found.");
  }
  return policy;
}

function requireMutablePolicy(policy: StoredModelPolicy, expectedVersion: number) {
  if (policy.version !== expectedVersion) {
    throw problem(
      409,
      "version_conflict",
      `Expected model policy version ${expectedVersion}, found ${policy.version}.`,
    );
  }
  if (policy.status !== "active") {
    throw problem(409, "resource_inactive", "Archived model policies cannot be changed.");
  }
}

function handleModelRoute(
  name: ModelRouteName,
  id: string | undefined,
  request: PlatformRequest,
  body: Readonly<Record<string, unknown>>,
  now: string,
  state: TenancyMockState,
): unknown {
  const environmentId = scope(request).environmentId;
  switch (name) {
    case "listModels":
      return listModels(request, state);
    case "listModelPolicies": {
      const query = queryRecord(request, POLICIES_QUERY_FIELDS);
      const policies = [...state.modelPolicies.values()]
        .filter((policy) => policy.environmentId === environmentId)
        .map(policyResponse);
      return page(policies, {
        ...(typeof query.cursor === "string" ? { cursor: query.cursor } : {}),
        limit: queryLimit(query.limit),
      });
    }
    case "createModelPolicy": {
      const models = body.models as readonly string[];
      assertPolicyRules(models);
      if (activePolicy(state, environmentId)) {
        throw problem(
          409,
          "model_policy_exists",
          "The environment already has an active model policy; update or archive it instead.",
        );
      }
      const policy: StoredModelPolicy = {
        createdAt: now,
        ...(body.description !== undefined ? { description: body.description } : {}),
        environmentId,
        id: nextPublicId(state),
        includeCuratedModels: body.includeCuratedModels as boolean,
        models: [...models],
        name: body.name,
        status: "active",
        updatedAt: now,
        version: 1,
      };
      state.modelPolicies.set(policy.id, policy);
      return policyResponse(policy);
    }
    case "getModelPolicy":
      return policyResponse(requirePolicy(state, environmentId, id!));
    case "updateModelPolicy": {
      const prior = requirePolicy(state, environmentId, id!);
      requireMutablePolicy(prior, body.expectedVersion as number);
      const models = (body.models as readonly string[] | undefined) ?? prior.models;
      assertPolicyRules(models);
      const { expectedVersion: _expectedVersion, ...changes } = body;
      const next: StoredModelPolicy = {
        ...prior,
        ...changes,
        models: [...models],
        updatedAt: now,
        version: prior.version + 1,
      };
      state.modelPolicies.set(next.id, next);
      return policyResponse(next);
    }
    case "archiveModelPolicy": {
      const prior = requirePolicy(state, environmentId, id!);
      requireMutablePolicy(prior, body.expectedVersion as number);
      const next: StoredModelPolicy = {
        ...prior,
        archivedAt: now,
        status: "archived",
        updatedAt: now,
        version: prior.version + 1,
      };
      state.modelPolicies.set(next.id, next);
      return policyResponse(next);
    }
  }
}

/** Serves the public model catalog and environment model-policy routes from mock state. */
export function mockModelData(
  request: PlatformRequest,
  now: string,
  state: TenancyMockState,
): ModelMockResult {
  const route = modelRoute(request);
  if (!route) return { matched: false };
  const mutation = request.method !== "GET";
  let body: Readonly<Record<string, unknown>> = {};
  try {
    validateRouteScope("environment", request);
    if (mutation) {
      body = decodePublicRequest(route.name, request.body) as Readonly<Record<string, unknown>>;
      if (
        typeof request.idempotencyKey !== "string" ||
        request.idempotencyKey.length < 1 ||
        request.idempotencyKey.length > 255
      ) {
        throw new TypeError(`Route ${route.name} requires an idempotency key.`);
      }
    } else if (request.body !== undefined) {
      throw new TypeError(`Route ${route.name} does not accept a request body.`);
    }
  } catch (error) {
    throw new PlatformRequestError(
      error instanceof Error ? error.message : "Invalid model mock request.",
    );
  }
  const fingerprint = mutation
    ? JSON.stringify(
        canonicalValue({
          body,
          context: request.context ?? null,
          method: request.method,
          path: request.path,
        }),
      )
    : undefined;
  const prior = mutation ? state.idempotencyResults.get(request.idempotencyKey!) : undefined;
  if (prior) {
    if (prior.fingerprint !== fingerprint) {
      throw new PlatformRequestError(
        "The idempotency key was already used for a different request.",
      );
    }
    return { data: structuredClone(prior.data), matched: true };
  }
  const data = decodePublicResponse(
    route.name,
    handleModelRoute(route.name, route.id, request, body, now, state),
  );
  if (mutation) {
    state.idempotencyResults.set(request.idempotencyKey!, {
      data: structuredClone(data),
      fingerprint: fingerprint!,
    });
  }
  return { data, matched: true };
}
