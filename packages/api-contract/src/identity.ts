import { Schema } from "effect";
import { PublicId, ScopeList } from "./primitives.ts";
import type { PublicApiRouteContract } from "./route-contract.ts";
import { OrganizationRole } from "./tenancy.ts";

export const IdentityResponse = Schema.Struct({
  authentication: Schema.Literals(["api-credential", "tenant-jwt"]),
  /**
   * Token scopes; for a human caller that selected an organization, intersected with what the
   * caller's organization role permits there.
   */
  capabilities: ScopeList,
  environmentId: Schema.optional(PublicId),
  environmentIds: Schema.Array(PublicId),
  id: Schema.String,
  organizationId: Schema.optional(PublicId),
  organizationIds: Schema.Array(PublicId),
  /** The human caller's live role in the organization selected by `x-deployments-organization`. */
  organizationRole: Schema.optional(OrganizationRole),
  /** Set for platform administrators, who bypass organization role restrictions. */
  platformRole: Schema.optional(Schema.Literal("administrator")),
  projectId: Schema.optional(PublicId),
  projectIds: Schema.Array(PublicId),
  workspaceId: Schema.optional(PublicId),
});

export const StartDeviceAuthorizationRequest = Schema.Struct({
  clientId: Schema.Literal("deployments-cli"),
});

export const DeviceAuthorizationResponse = Schema.Struct({
  deviceCode: Schema.String,
  expiresIn: Schema.Number,
  interval: Schema.Number,
  userCode: Schema.String,
  verificationUri: Schema.String,
  verificationUriComplete: Schema.optional(Schema.String),
});

export const ExchangeDeviceAuthorizationRequest = Schema.Struct({
  deviceCode: Schema.optional(Schema.String),
  refreshToken: Schema.optional(Schema.String),
}).pipe(
  Schema.check(
    Schema.makeFilter<{
      readonly deviceCode?: string | undefined;
      readonly refreshToken?: string | undefined;
    }>((input) =>
      Boolean(input.deviceCode) !== Boolean(input.refreshToken)
        ? undefined
        : "Provide exactly one of deviceCode or refreshToken.",
    ),
  ),
);

export const DeviceTokenResponse = Schema.Struct({
  bearerToken: Schema.String,
  expiresIn: Schema.Number,
  refreshToken: Schema.optional(Schema.String),
  tokenType: Schema.Literal("Bearer"),
});

export const RevokeDeviceAuthorizationRequest = Schema.Struct({
  refreshToken: Schema.String,
});

export const DeviceRevocationResponse = Schema.Struct({
  revoked: Schema.Literal(true),
});

export const IDENTITY_API_SCHEMAS = {
  DeviceAuthorizationResponse,
  DeviceRevocationResponse,
  DeviceTokenResponse,
  ExchangeDeviceAuthorizationRequest,
  IdentityResponse,
  RevokeDeviceAuthorizationRequest,
  StartDeviceAuthorizationRequest,
} as const;

export const IDENTITY_API_ROUTES = [
  {
    authentication: "none",
    errors: [400, 429, 500, 503],
    idempotency: "none",
    method: "POST",
    name: "startDeviceAuthorization",
    path: "/v1/device-authorizations",
    requestBody: "StartDeviceAuthorizationRequest",
    responseBody: "DeviceAuthorizationResponse",
    scopeHeaders: "none",
    successStatus: 200,
    tag: "Security",
  },
  {
    authentication: "none",
    errors: [400, 429, 500, 503],
    idempotency: "none",
    method: "POST",
    name: "revokeDeviceAuthorization",
    path: "/v1/device-authorizations/revoke",
    requestBody: "RevokeDeviceAuthorizationRequest",
    responseBody: "DeviceRevocationResponse",
    scopeHeaders: "none",
    successStatus: 200,
    tag: "Security",
  },
  {
    authentication: "none",
    errors: [400, 429, 500, 503],
    idempotency: "none",
    method: "POST",
    name: "exchangeDeviceAuthorization",
    path: "/v1/device-authorizations/token",
    requestBody: "ExchangeDeviceAuthorizationRequest",
    responseBody: "DeviceTokenResponse",
    scopeHeaders: "none",
    successStatus: 200,
    tag: "Security",
  },
  {
    authentication: "platform-bearer",
    errors: [401, 500],
    idempotency: "none",
    method: "GET",
    name: "getIdentity",
    path: "/v1/whoami",
    responseBody: "IdentityResponse",
    scopeHeaders: "none",
    successStatus: 200,
    tag: "Security",
  },
] as const satisfies readonly PublicApiRouteContract[];
