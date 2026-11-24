import { Schema } from "effect";
import { Cursor, PublicId, Timestamp } from "./primitives.ts";
import type { PublicApiQueryParameter, PublicApiRouteContract } from "./route-contract.ts";

export const IDENTITY_FEDERATION_PATHS = {
  identityProvider: "/v1/identity-provider",
  loginDomains: "/v1/login-domains",
} as const;

function text(label: string, maximum: number) {
  return Schema.String.pipe(
    Schema.check(
      Schema.isTrimmed({ message: `${label} must not contain surrounding whitespace.` }),
      Schema.isMinLength(1, { message: `${label} must not be empty.` }),
      Schema.isMaxLength(maximum, { message: `${label} must not exceed ${maximum} characters.` }),
    ),
  );
}

export const AddLoginDomainRequest = Schema.Struct({ domain: text("Login domains", 253) });

export const LoginDomainResponse = Schema.Struct({
  createdAt: Timestamp,
  dnsRecord: Schema.Struct({
    name: Schema.String,
    type: Schema.Literal("TXT"),
    value: Schema.String,
  }),
  domain: Schema.String,
  id: PublicId,
  state: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("pending") }),
    Schema.Struct({ kind: Schema.Literal("verified"), verifiedAt: Timestamp }),
  ]),
  updatedAt: Timestamp,
});

export const ListLoginDomainsResponse = Schema.Struct({
  items: Schema.Array(LoginDomainResponse),
  nextCursor: Schema.optional(Schema.NullOr(Cursor)),
});

const FederationJitPolicy = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("disabled") }),
  Schema.Struct({ kind: Schema.Literal("enabled"), role: Schema.Literals(["member", "viewer"]) }),
]);

const IdentityProviderEnforcement = Schema.Literals(["optional", "required"]);

const OidcIdentityProviderRequest = Schema.Struct({
  clientId: text("Client IDs", 512),
  clientSecret: Schema.optional(text("Client secrets", 4_096)),
  displayName: text("Display names", 120),
  issuer: text("Issuers", 2_048),
  jit: FederationJitPolicy,
  /** Absent means OIDC, so bodies written before SAML keep their meaning. */
  protocol: Schema.optional(Schema.Literal("oidc")),
});

const SamlUnsolicitedSignIn = Schema.Literals(["disabled", "enabled"]);

const SamlIdentityProviderRequest = Schema.Struct({
  displayName: text("Display names", 120),
  /**
   * The assertion attribute holding the email. When set, it is the only source; an
   * emailAddress-format NameID is never read.
   */
  emailAttribute: Schema.optional(text("Email attributes", 256)),
  jit: FederationJitPolicy,
  metadata: Schema.Union([
    Schema.Struct({ url: text("Metadata URLs", 2_048) }),
    Schema.Struct({
      document: Schema.String.pipe(
        Schema.check(
          Schema.isMinLength(1, { message: "Metadata documents must not be empty." }),
          Schema.isMaxLength(262_144, {
            message: "Metadata documents must not exceed 262144 characters.",
          }),
        ),
      ),
    }),
  ]),
  protocol: Schema.Literal("saml"),
  /** IdP-initiated sign-in; absent means disabled. */
  unsolicitedSignIn: Schema.optional(SamlUnsolicitedSignIn),
});

export const PutIdentityProviderRequest = Schema.Union([
  OidcIdentityProviderRequest,
  SamlIdentityProviderRequest,
]);

export const SetIdentityProviderStateRequest = Schema.Union([
  Schema.Struct({ enforcement: IdentityProviderEnforcement, kind: Schema.Literal("active") }),
  Schema.Struct({ kind: Schema.Literal("disabled") }),
]);

export const IdentityProviderState = Schema.Union([
  Schema.Struct({ enforcement: IdentityProviderEnforcement, kind: Schema.Literal("active") }),
  Schema.Struct({ disabledAt: Timestamp, kind: Schema.Literal("disabled") }),
]);

const identityProviderResponseFields = {
  /** Changes whenever the connection's identity changes: issuer and client ID, or entity ID. */
  connectionId: PublicId,
  createdAt: Timestamp,
  displayName: Schema.String,
  issuer: Schema.String,
  jit: FederationJitPolicy,
  organizationId: PublicId,
  state: IdentityProviderState,
  updatedAt: Timestamp,
};

export const OidcIdentityProviderResponse = Schema.Struct({
  ...identityProviderResponseFields,
  clientId: Schema.String,
  clientSecretSetAt: Timestamp,
  endpoints: Schema.Struct({
    authorization: Schema.String,
    jwks: Schema.String,
    token: Schema.String,
    userinfo: Schema.optional(Schema.String),
  }),
  protocol: Schema.Literal("oidc"),
  redirectUri: Schema.String,
  signingAlgorithms: Schema.Array(Schema.Literals(["RS256", "PS256", "ES256"])),
  tokenEndpointAuthMethod: Schema.Literals(["client_secret_basic", "client_secret_post"]),
});

const SamlIdentityProviderResponse = Schema.Struct({
  ...identityProviderResponseFields,
  emailAttribute: Schema.optional(Schema.String),
  metadataUrl: Schema.optional(Schema.String),
  protocol: Schema.Literal("saml"),
  /** The values to register with the identity provider. */
  serviceProvider: Schema.Struct({
    acsUrl: Schema.String,
    entityId: Schema.String,
    metadataUrl: Schema.String,
  }),
  signingCertificates: Schema.Array(
    Schema.Struct({ notAfter: Timestamp, sha256Fingerprint: Schema.String }),
  ),
  singleSignOnUrl: Schema.String,
  unsolicitedSignIn: SamlUnsolicitedSignIn,
});

export const IdentityProviderResponse = Schema.Union([
  OidcIdentityProviderResponse,
  SamlIdentityProviderResponse,
]);

export const IdentityProviderLinkResponse = Schema.Struct({
  createdAt: Timestamp,
  email: Schema.optional(Schema.String),
  id: PublicId,
  issuer: Schema.String,
  principalId: PublicId,
  subject: Schema.String,
});

export const ListIdentityProviderLinksResponse = Schema.Struct({
  items: Schema.Array(IdentityProviderLinkResponse),
  nextCursor: Schema.optional(Schema.NullOr(Cursor)),
});

export type AddLoginDomainRequest = typeof AddLoginDomainRequest.Type;
export type LoginDomainResponse = typeof LoginDomainResponse.Type;
export type PutIdentityProviderRequest = typeof PutIdentityProviderRequest.Type;
export type SetIdentityProviderStateRequest = typeof SetIdentityProviderStateRequest.Type;
export type IdentityProviderState = typeof IdentityProviderState.Type;
export type OidcIdentityProviderResponse = typeof OidcIdentityProviderResponse.Type;
export type IdentityProviderResponse = typeof IdentityProviderResponse.Type;
export type IdentityProviderLinkResponse = typeof IdentityProviderLinkResponse.Type;

export const IDENTITY_FEDERATION_API_SCHEMAS = {
  AddLoginDomainRequest,
  IdentityProviderLinkResponse,
  IdentityProviderResponse,
  ListIdentityProviderLinksResponse,
  ListLoginDomainsResponse,
  LoginDomainResponse,
  PutIdentityProviderRequest,
  SetIdentityProviderStateRequest,
} as const;

type IdentityFederationSchemaName = keyof typeof IDENTITY_FEDERATION_API_SCHEMAS;

const pageQuery = [
  { name: "cursor", schema: { maxLength: 4_096, minLength: 1, type: "string" } },
  { name: "limit", schema: { maximum: 100, minimum: 1, type: "integer" } },
] as const satisfies readonly PublicApiQueryParameter[];

function readRoute<
  const Route extends {
    readonly name: string;
    readonly path: string;
    readonly queryParameters?: readonly PublicApiQueryParameter[];
    readonly responseBody: IdentityFederationSchemaName;
  },
>(route: Route) {
  return {
    authentication: "platform-bearer",
    errors: [400, 401, 403, 404, 422],
    idempotency: "none",
    method: "GET",
    requiredAuthorization: "members:read",
    scopeHeaders: "organization",
    successStatus: 200,
    tag: "Security",
    ...route,
  } as const;
}

function writeRoute<
  const Route extends {
    readonly errors?: readonly number[];
    readonly method: "DELETE" | "POST" | "PUT";
    readonly name: string;
    readonly path: string;
    readonly requestBody?: IdentityFederationSchemaName;
    readonly responseBody: IdentityFederationSchemaName;
    readonly successStatus?: number;
  },
>(route: Route) {
  return {
    authentication: "platform-bearer",
    idempotency: "required",
    requiredAuthorization: "members:write",
    scopeHeaders: "organization",
    tag: "Security",
    ...route,
    errors: route.errors ?? [400, 401, 403, 404, 409, 422, 429],
    successStatus: route.successStatus ?? 200,
  } as const;
}

const { identityProvider, loginDomains } = IDENTITY_FEDERATION_PATHS;

export const IDENTITY_FEDERATION_API_ROUTES = [
  readRoute({
    name: "listLoginDomains",
    path: loginDomains,
    queryParameters: pageQuery,
    responseBody: "ListLoginDomainsResponse",
  }),
  writeRoute({
    method: "POST",
    name: "addLoginDomain",
    path: loginDomains,
    requestBody: "AddLoginDomainRequest",
    responseBody: "LoginDomainResponse",
    successStatus: 201,
  }),
  writeRoute({
    errors: [400, 401, 403, 404, 409, 422, 429, 503],
    method: "POST",
    name: "verifyLoginDomain",
    path: `${loginDomains}/:id/verify`,
    responseBody: "LoginDomainResponse",
  }),
  writeRoute({
    method: "DELETE",
    name: "removeLoginDomain",
    path: `${loginDomains}/:id`,
    responseBody: "LoginDomainResponse",
  }),
  readRoute({
    name: "getIdentityProvider",
    path: identityProvider,
    responseBody: "IdentityProviderResponse",
  }),
  writeRoute({
    method: "PUT",
    name: "putIdentityProvider",
    path: identityProvider,
    requestBody: "PutIdentityProviderRequest",
    responseBody: "IdentityProviderResponse",
  }),
  writeRoute({
    method: "PUT",
    name: "setIdentityProviderState",
    path: `${identityProvider}/state`,
    requestBody: "SetIdentityProviderStateRequest",
    responseBody: "IdentityProviderResponse",
  }),
  writeRoute({
    method: "DELETE",
    name: "deleteIdentityProvider",
    path: identityProvider,
    responseBody: "IdentityProviderResponse",
  }),
  readRoute({
    name: "listIdentityProviderLinks",
    path: `${identityProvider}/links`,
    queryParameters: pageQuery,
    responseBody: "ListIdentityProviderLinksResponse",
  }),
  writeRoute({
    method: "DELETE",
    name: "deleteIdentityProviderLink",
    path: `${identityProvider}/links/:id`,
    responseBody: "IdentityProviderLinkResponse",
  }),
] as const satisfies readonly PublicApiRouteContract[];

export type IdentityFederationRouteName = (typeof IDENTITY_FEDERATION_API_ROUTES)[number]["name"];
