import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import {
  DNS_HOST_NAME_PATTERN,
  NonEmptyString,
  Timestamp,
  makeRecordSchema,
  makeUnionRecordSchema,
  mutableResourceFields,
} from "../record-schema.ts";
import { IdentityProtectedEnvelope } from "./identity-envelope.ts";

const expires = { expiresAtField: "expiresAt" } as const;

export const LoginDomain = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(DNS_HOST_NAME_PATTERN, {
      message: "Login domains are lowercase ASCII host names with at least two labels.",
    }),
  ),
  Schema.brand("LoginDomain"),
);
export type LoginDomain = typeof LoginDomain.Type;

export const HttpsUrl = NonEmptyString.pipe(
  Schema.check(
    Schema.makeFilter<string>((input) => {
      if (!URL.canParse(input)) return "Expected an absolute URL.";
      const url = new URL(input);
      return url.protocol === "https:" && !url.username && !url.password && !url.hash
        ? undefined
        : "Expected an https URL without credentials or fragment.";
    }),
  ),
);

export const FederationSigningAlgorithm = Schema.Literals(["RS256", "PS256", "ES256"]);
export type FederationSigningAlgorithm = typeof FederationSigningAlgorithm.Type;

export const FederationJitRole = Schema.Literals(["member", "viewer"]);
export type FederationJitRole = typeof FederationJitRole.Type;

export const FederationJitPolicy = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("disabled") }),
  Schema.Struct({ kind: Schema.Literal("enabled"), role: FederationJitRole }),
]);
export type FederationJitPolicy = typeof FederationJitPolicy.Type;

export const IdentityProviderEnforcement = Schema.Literals(["optional", "required"]);
export type IdentityProviderEnforcement = typeof IdentityProviderEnforcement.Type;

export const IdentityProviderState = Schema.Union([
  Schema.Struct({ enforcement: IdentityProviderEnforcement, kind: Schema.Literal("active") }),
  Schema.Struct({ disabledAt: Timestamp, kind: Schema.Literal("disabled") }),
]);
export type IdentityProviderState = typeof IdentityProviderState.Type;

export const FederationTokenEndpointAuthMethod = Schema.Literals([
  "client_secret_basic",
  "client_secret_post",
]);

/**
 * The provider row's storage id, named when only OIDC existed. The row holds whichever protocol the
 * organization uses and derives the SK `ORGANIZATION-IDENTITY-PROVIDER#oidc`, so changing the
 * value is a data migration.
 */
export const IDENTITY_PROVIDER_SLOT = "oidc";

/** An issuer persisted outside the provider row: an OIDC https issuer or any SAML entity ID. */
export const FederationIssuer = NonEmptyString;

const identityProviderFields = {
  ...mutableResourceFields,
  connectionId: Ulid,
  displayName: NonEmptyString,
  id: Schema.Literal(IDENTITY_PROVIDER_SLOT),
  jit: FederationJitPolicy,
  organizationId: Ulid,
  state: IdentityProviderState,
} as const;

/** OIDC rows written before SAML existed have no `protocol`; OIDC writes still omit it. */
export const OidcIdentityProvider = Schema.Struct({
  ...identityProviderFields,
  clientId: NonEmptyString,
  clientSecret: IdentityProtectedEnvelope,
  clientSecretSetAt: Timestamp,
  endpoints: Schema.Struct({
    authorization: HttpsUrl,
    jwks: HttpsUrl,
    token: HttpsUrl,
    userinfo: Schema.optionalKey(HttpsUrl),
  }),
  issuer: HttpsUrl,
  protocol: Schema.optionalKey(Schema.Literal("oidc")),
  signingAlgorithms: Schema.NonEmptyArray(FederationSigningAlgorithm),
  tokenEndpointAuthMethod: FederationTokenEndpointAuthMethod,
});
export type OidcIdentityProvider = typeof OidcIdentityProvider.Type;

export const SamlSigningCertificate = Schema.Struct({
  certificate: NonEmptyString,
  notAfter: Timestamp,
  sha256Fingerprint: NonEmptyString,
});
export type SamlSigningCertificate = typeof SamlSigningCertificate.Type;

export const SamlUnsolicitedSignIn = Schema.Literals(["disabled", "enabled"]);
export type SamlUnsolicitedSignIn = typeof SamlUnsolicitedSignIn.Type;

export const SamlIdentityProvider = Schema.Struct({
  ...identityProviderFields,
  emailAttribute: Schema.optionalKey(NonEmptyString),
  issuer: NonEmptyString.pipe(Schema.check(Schema.isMaxLength(512))),
  metadataUrl: Schema.optionalKey(HttpsUrl),
  protocol: Schema.Literal("saml"),
  signingCertificates: Schema.NonEmptyArray(SamlSigningCertificate).pipe(
    Schema.check(Schema.isMaxLength(4)),
  ),
  singleSignOnUrl: HttpsUrl,
  unsolicitedSignIn: SamlUnsolicitedSignIn,
});
export type SamlIdentityProvider = typeof SamlIdentityProvider.Type;

/** One row per organization, so its single SK keeps an organization to one provider of any protocol. */
export const OrganizationIdentityProviderRecord = makeUnionRecordSchema(
  "organization-identity-provider",
  [OidcIdentityProvider, SamlIdentityProvider],
);
export type OrganizationIdentityProviderRecord = typeof OrganizationIdentityProviderRecord.Type;
export type IdentityProviderData = OrganizationIdentityProviderRecord["data"];
export type IdentityProviderProtocol = "oidc" | "saml";

export function identityProviderProtocol(data: IdentityProviderData): IdentityProviderProtocol {
  return data.protocol ?? "oidc";
}

export const LoginDomainState = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("pending") }),
  Schema.Struct({ kind: Schema.Literal("verified"), verifiedAt: Timestamp }),
]);
export type LoginDomainState = typeof LoginDomainState.Type;

export const OrganizationLoginDomainRecord = makeRecordSchema("organization-login-domain", {
  ...mutableResourceFields,
  domain: LoginDomain,
  id: Ulid,
  organizationId: Ulid,
  state: LoginDomainState,
  verificationToken: NonEmptyString,
});
export type OrganizationLoginDomainRecord = typeof OrganizationLoginDomainRecord.Type;

export const OrganizationFederatedGrantRecord = makeRecordSchema(
  "organization-federated-grant",
  {
    authenticatedAt: Timestamp,
    connectionId: Ulid,
    createdAt: Timestamp,
    expiresAt: Timestamp,
    id: Ulid,
    issuer: FederationIssuer,
    organizationId: Ulid,
    principalId: Ulid,
    subject: NonEmptyString,
  },
  expires,
);
export type OrganizationFederatedGrantRecord = typeof OrganizationFederatedGrantRecord.Type;

export const FederatedAuthentication = Schema.Struct({
  authenticatedAt: Timestamp,
  connectionId: Ulid,
  issuer: FederationIssuer,
  method: Schema.Literal("federated"),
  organizationId: Ulid,
  subject: NonEmptyString,
});
export type FederatedAuthentication = typeof FederatedAuthentication.Type;

/** The factor that completed a password sign-in. A session without one used the password alone. */
export const PasswordSecondFactor = Schema.Literals(["totp", "recovery-code"]);
export type PasswordSecondFactor = typeof PasswordSecondFactor.Type;

export const PasswordAuthentication = Schema.Struct({
  method: Schema.Literal("password"),
  secondFactor: Schema.optionalKey(PasswordSecondFactor),
});
export type PasswordAuthentication = typeof PasswordAuthentication.Type;

export const IdentitySessionAuthentication = Schema.Union([
  PasswordAuthentication,
  FederatedAuthentication,
]);
export type IdentitySessionAuthentication = typeof IdentitySessionAuthentication.Type;

export const IdentityFederationTransactionRecord = makeRecordSchema(
  "identity-federation-transaction",
  {
    ...mutableResourceFields,
    connectionId: Ulid,
    expiresAt: Timestamp,
    forceLogin: Schema.Boolean,
    id: Ulid,
    lookupHash: NonEmptyString,
    organizationId: Ulid,
    returnTo: NonEmptyString,
    status: Schema.Literals(["pending", "consumed"]),
  },
  expires,
);
export type IdentityFederationTransactionRecord = typeof IdentityFederationTransactionRecord.Type;

export const IdentityFederationLinkRequestRecord = makeRecordSchema(
  "identity-federation-link-request",
  {
    ...mutableResourceFields,
    bindingHash: NonEmptyString,
    connectionId: Ulid,
    expiresAt: Timestamp,
    id: Ulid,
    issuer: FederationIssuer,
    organizationId: Ulid,
    principalId: Ulid,
    status: Schema.Literals(["pending", "consumed"]),
    subject: NonEmptyString,
    tokenHash: NonEmptyString,
  },
  expires,
);
export type IdentityFederationLinkRequestRecord = typeof IdentityFederationLinkRequestRecord.Type;

const unsolicitedSignInFields = {
  ...mutableResourceFields,
  assertionKey: NonEmptyString,
  connectionId: Ulid,
  expiresAt: Timestamp,
  id: Ulid,
  organizationId: Ulid,
  tokenHash: NonEmptyString,
} as const;

/**
 * An IdP-initiated SAML sign-in between the ACS and the browser's confirmation. It owns the
 * expiring replay claim on `assertionKey`, so consuming it keeps the claim until `expiresAt`.
 */
export const IdentityFederationUnsolicitedSignInRecord = makeUnionRecordSchema(
  "identity-federation-unsolicited-sign-in",
  [
    Schema.Struct({
      ...unsolicitedSignInFields,
      claims: Schema.Struct({
        displayName: Schema.optionalKey(NonEmptyString),
        email: NonEmptyString,
        emailDomain: NonEmptyString,
        issuer: FederationIssuer,
        subject: NonEmptyString,
      }),
      returnTo: NonEmptyString,
      status: Schema.Literal("pending"),
    }),
    Schema.Struct({ ...unsolicitedSignInFields, status: Schema.Literal("consumed") }),
  ],
  expires,
);
export type IdentityFederationUnsolicitedSignInRecord =
  typeof IdentityFederationUnsolicitedSignInRecord.Type;

export const FEDERATION_CONTROL_RECORD_SCHEMAS = {
  "organization-federated-grant": OrganizationFederatedGrantRecord,
  "organization-identity-provider": OrganizationIdentityProviderRecord,
  "organization-login-domain": OrganizationLoginDomainRecord,
} as const;

export const FEDERATION_IDENTITY_RECORD_SCHEMAS = {
  "identity-federation-link-request": IdentityFederationLinkRequestRecord,
  "identity-federation-transaction": IdentityFederationTransactionRecord,
  "identity-federation-unsolicited-sign-in": IdentityFederationUnsolicitedSignInRecord,
} as const;
