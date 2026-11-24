import { Schema } from "effect";
import { PublicId, Timestamp } from "./primitives.ts";
import type { PublicApiRouteContract } from "./route-contract.ts";

/** Providers an organization can bring its own key for; Bedrock authenticates with IAM instead. */
export const MODEL_CREDENTIAL_PROVIDERS = ["openai", "openrouter"] as const;
export const ModelCredentialProvider = Schema.Literals(MODEL_CREDENTIAL_PROVIDERS);
export type ModelCredentialProvider = typeof ModelCredentialProvider.Type;

const Label = Schema.String.pipe(
  Schema.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(100)),
);

export const PutModelCredentialRequest = Schema.Struct({
  apiKey: Schema.String.annotate({
    description: "The provider API key. It is verified with the provider, then stored encrypted.",
  }).pipe(Schema.check(Schema.isPattern(/^\S{8,1024}$/u))),
  label: Schema.optionalKey(Label),
});

export const ModelCredentialResponse = Schema.Struct({
  createdAt: Timestamp,
  credentialId: PublicId,
  keyVersion: Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))),
  label: Schema.optional(Label),
  lastFour: Schema.String.annotate({
    description: "The last four characters of the stored key. The key itself is never returned.",
  }),
  provider: ModelCredentialProvider,
  revokedAt: Schema.optional(Timestamp),
  revokedBy: Schema.optional(PublicId),
  setAt: Timestamp,
  setBy: PublicId,
  status: Schema.Literals(["active", "revoked"]),
  updatedAt: Timestamp,
  version: Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))),
});

export const ListModelCredentialsResponse = Schema.Struct({
  items: Schema.Array(ModelCredentialResponse),
});

export type PutModelCredentialRequest = typeof PutModelCredentialRequest.Type;
export type ModelCredentialResponse = typeof ModelCredentialResponse.Type;
export type ListModelCredentialsResponse = typeof ListModelCredentialsResponse.Type;

export const MODEL_CREDENTIAL_API_SCHEMAS = {
  ListModelCredentialsResponse,
  ModelCredentialResponse,
  PutModelCredentialRequest,
} as const;

const MODEL_CREDENTIALS_PATH = "/v1/organizations/:id/model-credentials";
const providerParameter = {
  description: "Model provider whose key this is.",
  name: "provider",
  schema: { enum: MODEL_CREDENTIAL_PROVIDERS, type: "string" },
} as const;

function modelCredentialRoute<
  const Route extends Omit<
    PublicApiRouteContract,
    "authentication" | "errors" | "idempotency" | "requiredAuthorization" | "scopeHeaders" | "tag"
  >,
>(route: Route) {
  const mutation = route.method !== "GET";
  return {
    authentication: "platform-bearer" as const,
    errors: mutation ? [400, 401, 403, 404, 409, 422, 429, 502] : [400, 401, 403, 404],
    idempotency: mutation ? ("required" as const) : ("none" as const),
    requiredAuthorization: mutation ? ("models:write" as const) : ("models:read" as const),
    scopeHeaders: "organization" as const,
    tag: "Models" as const,
    ...route,
  };
}

export const MODEL_CREDENTIAL_API_ROUTES = [
  modelCredentialRoute({
    method: "GET",
    name: "listModelCredentials",
    path: MODEL_CREDENTIALS_PATH,
    responseBody: "ListModelCredentialsResponse",
    successStatus: 200,
  }),
  modelCredentialRoute({
    method: "GET",
    name: "getModelCredential",
    path: `${MODEL_CREDENTIALS_PATH}/:provider`,
    pathParameters: [providerParameter],
    responseBody: "ModelCredentialResponse",
    successStatus: 200,
  }),
  modelCredentialRoute({
    method: "PUT",
    name: "putModelCredential",
    path: `${MODEL_CREDENTIALS_PATH}/:provider`,
    pathParameters: [providerParameter],
    requestBody: "PutModelCredentialRequest",
    responseBody: "ModelCredentialResponse",
    successStatus: 200,
  }),
  modelCredentialRoute({
    method: "DELETE",
    name: "deleteModelCredential",
    path: `${MODEL_CREDENTIALS_PATH}/:provider`,
    pathParameters: [providerParameter],
    responseBody: "ModelCredentialResponse",
    standing: "remediation",
    successStatus: 200,
  }),
] as const satisfies readonly PublicApiRouteContract[];
