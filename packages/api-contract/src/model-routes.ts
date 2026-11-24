import { MODEL_CAPABILITIES, MODEL_PROVIDERS } from "./model-schemas.ts";
import type { PublicApiRouteContract } from "./route-contract.ts";

type Input = Omit<
  PublicApiRouteContract,
  "authentication" | "errors" | "idempotency" | "requiredAuthorization" | "scopeHeaders" | "tag"
>;
const readErrors = [400, 401, 403, 404, 422] as const;
const mutationErrors = [400, 401, 403, 404, 409, 422, 429] as const;
const listQueryParameters = [
  { name: "cursor", schema: { maxLength: 4_096, minLength: 1, type: "string" } },
  { name: "limit", schema: { maximum: 100, minimum: 1, type: "integer" } },
] as const;
const modelFilterQueryParameters = [
  {
    description: "Restrict results to one model provider.",
    name: "provider",
    schema: { enum: MODEL_PROVIDERS, type: "string" },
  },
  {
    description: "Restrict results to models that advertise one capability.",
    name: "capability",
    schema: { enum: MODEL_CAPABILITIES, type: "string" },
  },
  {
    description: "Restrict results to models the environment's model policy allows or denies.",
    name: "allowed",
    schema: { type: "boolean" },
  },
  {
    description: "Restrict results to curated or non-curated models.",
    name: "curated",
    schema: { type: "boolean" },
  },
  {
    description: "Case-insensitive substring of the model id or display name.",
    name: "search",
    schema: { maxLength: 100, minLength: 1, type: "string" },
  },
] as const;

function modelRoute<const Route extends Input>(route: Route) {
  const mutation = route.method !== "GET";
  return {
    authentication: "platform-bearer" as const,
    errors: mutation ? mutationErrors : readErrors,
    idempotency: mutation ? ("required" as const) : ("none" as const),
    requiredAuthorization: mutation ? ("models:write" as const) : ("models:read" as const),
    scopeHeaders: "environment" as const,
    tag: "Models" as const,
    ...route,
  };
}

export const MODEL_API_ROUTES = [
  modelRoute({
    method: "GET",
    name: "listModels",
    path: "/v1/models",
    queryParameters: [...listQueryParameters, ...modelFilterQueryParameters],
    responseBody: "ListModelsResponse",
    successStatus: 200,
  }),
  modelRoute({
    method: "GET",
    name: "listModelPolicies",
    path: "/v1/model-policies",
    queryParameters: listQueryParameters,
    responseBody: "ListModelPoliciesResponse",
    successStatus: 200,
  }),
  modelRoute({
    method: "POST",
    name: "createModelPolicy",
    path: "/v1/model-policies",
    requestBody: "CreateModelPolicyRequest",
    responseBody: "ModelPolicyResponse",
    successStatus: 201,
  }),
  modelRoute({
    method: "GET",
    name: "getModelPolicy",
    path: "/v1/model-policies/:id",
    responseBody: "ModelPolicyResponse",
    successStatus: 200,
  }),
  modelRoute({
    method: "PATCH",
    name: "updateModelPolicy",
    path: "/v1/model-policies/:id",
    requestBody: "UpdateModelPolicyRequest",
    responseBody: "ModelPolicyResponse",
    successStatus: 200,
  }),
  modelRoute({
    method: "DELETE",
    name: "archiveModelPolicy",
    path: "/v1/model-policies/:id",
    requestBody: "ArchiveModelPolicyRequest",
    requestBodyRequired: true,
    responseBody: "ModelPolicyResponse",
    successStatus: 200,
  }),
] as const satisfies readonly PublicApiRouteContract[];

export type ModelApiRouteName = (typeof MODEL_API_ROUTES)[number]["name"];
