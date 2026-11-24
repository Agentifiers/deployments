import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import * as ControlFields from "./control-fields.ts";
import {
  Metadata,
  NonEmptyString,
  NonNegativeSafeInteger,
  SecretReference,
  StringList,
  Timestamp,
  makeRecordSchema,
  mutableResourceFields,
  tenantScopeFields,
  workspaceScopeFields,
} from "../record-schema.ts";

const status = ControlFields.status;

export const ProviderDefinitionRecord = makeRecordSchema("provider-definition", {
  ...mutableResourceFields,
  authMethods: StringList,
  codeVersion: Schema.String,
  displayName: Schema.String,
  key: Schema.String,
  metadata: Schema.optional(Metadata),
  route: Schema.Literals(["builtin", "mcp", "oauth", "static", "webhook"]),
  status,
  supportedScopes: StringList,
  supportedTools: StringList,
});

const TokenEndpointAuthMethod = Schema.Literals([
  "none",
  "client_secret_basic",
  "client_secret_post",
]);

// Dynamic registrations are bound to the authorization server that issued the client.
export const ProviderApplicationRegistration = Schema.Union([
  Schema.Struct({
    issuer: Schema.optional(NonEmptyString),
    method: Schema.Literal("pre_registered"),
    registeredAt: Schema.optional(Timestamp),
    tokenEndpointAuthMethod: TokenEndpointAuthMethod,
  }),
  Schema.Struct({
    issuer: NonEmptyString,
    method: Schema.Literal("dynamic_client_registration"),
    registeredAt: Schema.optional(Timestamp),
    tokenEndpointAuthMethod: TokenEndpointAuthMethod,
  }),
]);

export const ProviderApplicationRecord = makeRecordSchema("provider-application", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  clientId: NonEmptyString,
  clientSecretRef: Schema.optional(SecretReference),
  displayName: Schema.String,
  id: Ulid,
  metadata: Schema.optional(Metadata),
  providerKey: NonEmptyString,
  redirectUris: StringList,
  registration: Schema.optional(ProviderApplicationRegistration),
  requestedScopes: StringList,
  status,
});

export const ProviderConnectionRecord = makeRecordSchema("provider-connection", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  authMethod: Schema.String,
  authorizationScopes: Schema.optional(StringList),
  credentialRef: Schema.optional(SecretReference),
  displayMetadata: Schema.optional(Metadata),
  externalAccountId: Schema.optional(NonEmptyString),
  externalAccountName: Schema.optional(Schema.String),
  id: Ulid,
  lastVerifiedAt: Schema.optional(Schema.String),
  oauthClientId: Schema.optional(NonEmptyString),
  oauthClientRegistration: Schema.optional(ControlFields.OAuthClientRegistration),
  oauthIssuer: Schema.optional(NonEmptyString),
  oauthResource: Schema.optional(NonEmptyString),
  providerApplicationId: Schema.optional(Ulid),
  providerKey: NonEmptyString,
  refreshAfter: Schema.optional(Schema.String),
  rotationCleanupPending: Schema.optional(Schema.Boolean),
  rotationCleanupRequestHash: Schema.optional(NonEmptyString),
  scopes: StringList,
  status: Schema.Literals(["active", "disconnected", "error", "reauthorization-required"]),
});

export const CredentialVaultEntryRecord = makeRecordSchema(
  "credential-vault-entry",
  {
    ...mutableResourceFields,
    ...tenantScopeFields,
    algorithm: Schema.Literal("AES-256-GCM"),
    authTag: NonEmptyString,
    ciphertext: NonEmptyString,
    encryptedDataKey: NonEmptyString,
    encryptionContextHash: NonEmptyString,
    expiresAt: Schema.optional(Timestamp),
    generation: NonNegativeSafeInteger,
    id: Ulid,
    iv: NonEmptyString,
    kmsKeyArn: NonEmptyString,
    ownerId: Ulid,
    ownerType: Schema.Literals([
      "channel-binding",
      "mcp-server",
      "oauth-authorization-attempt",
      "provider-application",
      "provider-connection",
      "stream-session",
      "tool-adapter",
      "webhook-endpoint",
    ]),
    purpose: NonEmptyString,
    status: Schema.Literals(["active", "revoked"]),
  },
  {
    expiresAtField: "expiresAt",
    expiresAtRequired: false,
    expiresAtTtlRequired: false,
  },
);

export const OAuthAuthorizationAttemptRecord = makeRecordSchema(
  "oauth-authorization-attempt",
  {
    ...ControlFields.oauthAuthorizationAttemptFields,
    pkceSecretRef: Schema.optional(SecretReference),
  },
  { expiresAtField: "expiresAt" },
);

export const ConnectionVerificationRecord = makeRecordSchema("connection-verification", {
  ...mutableResourceFields,
  ...workspaceScopeFields,
  completedAt: Schema.optional(Schema.String),
  connectionId: Ulid,
  error: Schema.optional(Metadata),
  generationPin: Schema.optional(Metadata),
  id: Ulid,
  idempotencyKey: Schema.optional(Schema.String),
  leaseExpiresAt: Schema.optional(Schema.String),
  leaseOwner: Schema.optional(Schema.String),
  providerKey: NonEmptyString,
  result: Schema.optional(Metadata),
  status: Schema.Literals(["executing", "failed", "pending", "revoked", "verified"]),
});

export const ConnectionCapabilityRecord = makeRecordSchema("connection-capability", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  connectionId: Ulid,
  id: Ulid,
  metadata: Schema.optional(Metadata),
  providerKey: NonEmptyString,
  scopes: StringList,
  status: Schema.Literals(["active", "revoked", "stale"]),
  verificationVersion: Schema.Number,
});

export const WorkspaceConnectionAuthorizationRecord = makeRecordSchema(
  "workspace-connection-authorization",
  {
    ...mutableResourceFields,
    ...workspaceScopeFields,
    authorizationVersion: Schema.Number,
    connectionId: Ulid,
    externalAccountId: Schema.String,
    externalResourceConstraints: Metadata,
    id: Ulid,
    providerKey: NonEmptyString,
    purpose: Schema.String,
    resourceScopeHash: Schema.String,
    scopes: Schema.optional(StringList),
    status: Schema.Literals(["active", "revoked"]),
  },
);

/**
 * A grant without a workspace covers every workspace of its environment, but only while its
 * provider uses no credential. Pass that fact from the provider definition at the time of use,
 * so a provider that later gains a credential stops its existing environment grants.
 */
export function grantCoversWorkspace(
  grant: { readonly workspaceId?: Ulid | undefined },
  workspaceId: Ulid | undefined,
  providerUsesNoCredential: boolean,
): boolean {
  if (workspaceId === undefined) return false;
  if (grant.workspaceId === undefined) return providerUsesNoCredential;
  return grant.workspaceId === workspaceId;
}
