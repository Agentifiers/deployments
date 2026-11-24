import { Schema } from "effect";
import { PublicId, Timestamp } from "./primitives.ts";
import type { PublicApiRouteContract } from "./route-contract.ts";

export const DIRECTORY_PATHS = {
  directory: "/v1/directory",
  tokens: "/v1/directory/tokens",
} as const;

const DirectoryRole = Schema.Literals(["member", "viewer"]);

export const PutDirectoryRequest = Schema.Struct({
  /** The role SCIM grants when it adds or reactivates a member. */
  defaultRole: DirectoryRole,
});

const DirectoryTokenSummary = Schema.Struct({
  createdAt: Timestamp,
  createdBy: PublicId,
  id: PublicId,
  /** The leading characters of the token, for telling tokens apart. */
  tokenPrefix: Schema.String,
});

export const DirectoryResponse = Schema.Struct({
  createdAt: Timestamp,
  defaultRole: DirectoryRole,
  /** The SCIM 2.0 base URL to configure in the identity provider. */
  scimBaseUrl: Schema.String,
  tokens: Schema.Array(DirectoryTokenSummary),
  updatedAt: Timestamp,
});

export const DirectoryTokenCreatedResponse = Schema.Struct({
  directory: DirectoryResponse,
  token: Schema.Struct({
    ...DirectoryTokenSummary.fields,
    /** The bearer token. It is shown only in this response. */
    secret: Schema.String,
  }),
});

export type PutDirectoryRequest = typeof PutDirectoryRequest.Type;
export type DirectoryResponse = typeof DirectoryResponse.Type;
export type DirectoryTokenCreatedResponse = typeof DirectoryTokenCreatedResponse.Type;

export const DIRECTORY_API_SCHEMAS = {
  DirectoryResponse,
  DirectoryTokenCreatedResponse,
  PutDirectoryRequest,
} as const;

const administration = {
  authentication: "platform-bearer",
  scopeHeaders: "organization",
  tag: "Security",
} as const;

const writes = {
  ...administration,
  errors: [400, 401, 403, 404, 409, 422, 429],
  idempotency: "required",
  requiredAuthorization: "members:write",
} as const;

export const DIRECTORY_API_ROUTES = [
  {
    ...administration,
    errors: [400, 401, 403, 404, 422],
    idempotency: "none",
    method: "GET",
    name: "getDirectory",
    path: DIRECTORY_PATHS.directory,
    requiredAuthorization: "members:read",
    responseBody: "DirectoryResponse",
    successStatus: 200,
  },
  {
    ...writes,
    method: "PUT",
    name: "putDirectory",
    path: DIRECTORY_PATHS.directory,
    requestBody: "PutDirectoryRequest",
    responseBody: "DirectoryResponse",
    successStatus: 200,
  },
  {
    ...writes,
    method: "POST",
    name: "createDirectoryToken",
    path: DIRECTORY_PATHS.tokens,
    responseBody: "DirectoryTokenCreatedResponse",
    successStatus: 201,
  },
  {
    ...writes,
    method: "DELETE",
    name: "revokeDirectoryToken",
    path: `${DIRECTORY_PATHS.tokens}/:id`,
    responseBody: "DirectoryResponse",
    standing: "remediation",
    successStatus: 200,
  },
] as const satisfies readonly PublicApiRouteContract[];

export type DirectoryRouteName = (typeof DIRECTORY_API_ROUTES)[number]["name"];
