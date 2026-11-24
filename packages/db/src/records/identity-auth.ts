import { Effect, Schema } from "effect";
import { Ulid } from "../ids.ts";
import {
  ActorReference,
  Metadata,
  NonEmptyString,
  NonNegativeSafeInteger,
  Timestamp,
  makeRecordSchema,
  mutableResourceFields,
} from "../record-schema.ts";
import { AppLoginHandoffRecord, AppLoginTransactionRecord, AppSessionRecord } from "./apps.ts";
import { IdentityProtectedEnvelope } from "./identity-envelope.ts";
import {
  FEDERATION_IDENTITY_RECORD_SCHEMAS,
  IdentitySessionAuthentication,
} from "./identity-federation.ts";
import { MFA_IDENTITY_RECORD_SCHEMAS } from "./identity-mfa.ts";
import { ACCOUNT_IDENTITY_RECORD_SCHEMAS } from "./identity-account.ts";

const expires = { expiresAtField: "expiresAt" } as const;
const hash = NonEmptyString;
const scopeList = Schema.Array(NonEmptyString);

export const PrincipalCredentialRecord = makeRecordSchema("principal-credential", {
  ...mutableResourceFields,
  hashAlgorithm: Schema.Literal("scrypt"),
  hashParameters: Schema.Struct({
    blockSize: NonNegativeSafeInteger,
    keyLength: NonNegativeSafeInteger,
    memoryCost: NonNegativeSafeInteger,
    parallelization: NonNegativeSafeInteger,
    saltLength: NonNegativeSafeInteger,
  }),
  id: Schema.Literal("password"),
  kind: Schema.Literal("password"),
  passwordChangedAt: Timestamp,
  passwordHash: NonEmptyString,
  pepperVersion: Schema.optional(NonEmptyString),
  principalId: Ulid,
  status: Schema.Literals(["active", "disabled"]),
});

export const PrincipalSecurityStateRecord = makeRecordSchema("principal-security-state", {
  ...mutableResourceFields,
  authenticationFailedAt: Schema.optional(Timestamp),
  authenticationFailureCount: Schema.optional(NonNegativeSafeInteger),
  credentialVersion: NonNegativeSafeInteger,
  emailVerifiedAt: Schema.optional(Timestamp),
  id: Schema.Literal("current"),
  principalId: Ulid,
  sessionEpoch: NonNegativeSafeInteger,
  verificationEmailSentAt: Schema.optional(Timestamp),
});

export const IdentityRegistrationRecord = makeRecordSchema(
  "identity-registration",
  {
    ...mutableResourceFields,
    email: NonEmptyString,
    emailHash: hash,
    expiresAt: Timestamp,
    id: Ulid,
    verificationEmailSentAt: Timestamp,
  },
  expires,
);

export const IdentityRateLimitRecord = makeRecordSchema(
  "identity-rate-limit",
  {
    count: NonNegativeSafeInteger,
    consumedRequestIds: Schema.optional(Schema.Array(Ulid)),
    expiresAt: Timestamp,
    id: NonEmptyString,
    limitKey: NonEmptyString,
    scopeHash: hash,
    version: NonNegativeSafeInteger,
    window: NonEmptyString,
  },
  expires,
);

export const IdentityPublicEmailRequestRecord = makeRecordSchema(
  "identity-public-email-request",
  {
    ...mutableResourceFields,
    expiresAt: Timestamp,
    id: Ulid,
    operation: Schema.Literals(["password-recovery", "sign-up"]),
    processedAt: Timestamp,
    status: Schema.Literal("processed"),
  },
  expires,
);

export const IdentityBffRevocationFenceRecord = makeRecordSchema("identity-bff-revocation-fence", {
  ...mutableResourceFields,
  id: Ulid,
  principalId: Ulid,
  principalStatus: Schema.Literals(["active", "disabled", "archived"]),
  sessionEpoch: NonNegativeSafeInteger,
});

export const IdentityActionRecord = makeRecordSchema(
  "identity-action",
  {
    ...mutableResourceFields,
    consumedAt: Schema.optional(Timestamp),
    expiresAt: Timestamp,
    id: Ulid,
    issuedCredentialVersion: Schema.optional(NonNegativeSafeInteger),
    principalId: Ulid,
    purpose: Schema.Literals(["verify-email", "reset-password"]),
    status: Schema.Literals(["pending", "consumed", "expired", "revoked"]),
    targetEmail: Schema.optional(NonEmptyString),
    targetEmailHash: Schema.optional(hash),
    tokenHash: hash,
  },
  expires,
).pipe(
  Schema.refine(
    (record): record is typeof record =>
      record.data.purpose === "verify-email"
        ? record.data.targetEmail !== undefined &&
          record.data.targetEmailHash !== undefined &&
          record.data.issuedCredentialVersion === undefined
        : record.data.targetEmail === undefined &&
          record.data.targetEmailHash === undefined &&
          record.data.issuedCredentialVersion !== undefined,
    {
      message: "Identity actions must contain only purpose-specific bindings.",
    },
  ),
);

const emailDeliveryBase = {
  ...mutableResourceFields,
  actionId: Schema.optional(Ulid),
  attemptCount: NonNegativeSafeInteger,
  dispatchShard: Schema.String,
  expiresAt: Timestamp,
  id: Ulid,
  invitationId: Schema.optional(Ulid),
  lastAttemptAt: Schema.optional(Timestamp),
  organizationId: Schema.optional(Ulid),
  principalId: Ulid,
  purpose: Schema.Literals([
    "verify-email",
    "reset-password",
    "password-changed",
    "suspicious-refresh-reuse",
    "organization-invitation",
    "federated-identity-link",
    "mfa-enabled",
    "mfa-disabled",
    "email-change-verify",
    "email-changed",
    "email-change-reported",
    "account-deleted",
  ]),
} as const;

const PendingIdentityEmailDeliveryRecord = makeRecordSchema(
  "identity-email-delivery",
  {
    ...emailDeliveryBase,
    nextDispatchAt: Timestamp,
    protectedPayload: IdentityProtectedEnvelope,
    status: Schema.Literal("pending"),
  },
  expires,
);

const QueuedIdentityEmailDeliveryRecord = makeRecordSchema(
  "identity-email-delivery",
  {
    ...emailDeliveryBase,
    protectedPayload: IdentityProtectedEnvelope,
    queuedAt: Timestamp,
    status: Schema.Literal("queued"),
  },
  expires,
);

const SentIdentityEmailDeliveryRecord = makeRecordSchema(
  "identity-email-delivery",
  {
    ...emailDeliveryBase,
    sentAt: Timestamp,
    status: Schema.Literal("sent"),
  },
  expires,
);

const FailedIdentityEmailDeliveryRecord = makeRecordSchema(
  "identity-email-delivery",
  {
    ...emailDeliveryBase,
    failedAt: Timestamp,
    failureCategory: NonEmptyString,
    protectedPayload: IdentityProtectedEnvelope,
    status: Schema.Literal("failed"),
  },
  expires,
);

const DiscardedIdentityEmailDeliveryRecord = makeRecordSchema(
  "identity-email-delivery",
  {
    ...emailDeliveryBase,
    failedAt: Timestamp,
    failureCategory: NonEmptyString,
    status: Schema.Literal("discarded"),
  },
  expires,
);

export const IdentityEmailDeliveryRecord = Schema.Union([
  PendingIdentityEmailDeliveryRecord,
  QueuedIdentityEmailDeliveryRecord,
  SentIdentityEmailDeliveryRecord,
  FailedIdentityEmailDeliveryRecord,
  DiscardedIdentityEmailDeliveryRecord,
]).pipe(
  Schema.refine(
    (record): record is typeof record => /^(0[0-9]|1[0-5])$/u.test(record.data.dispatchShard),
    { message: "Identity email delivery shards must be between 00 and 15." },
  ),
  Schema.refine(
    (record): record is typeof record =>
      record.data.purpose === "organization-invitation"
        ? record.data.invitationId !== undefined &&
          record.data.organizationId !== undefined &&
          record.data.actionId === undefined
        : record.data.invitationId === undefined && record.data.organizationId === undefined,
    {
      message:
        "Organization invitation deliveries require invitation bindings, and only they may carry them.",
    },
  ),
);

export const IdentitySecurityEventRecord = makeRecordSchema("identity-security-event", {
  actor: Schema.optional(ActorReference),
  aggregateId: Ulid,
  aggregateType: NonEmptyString,
  aggregateVersion: NonNegativeSafeInteger,
  eventId: Ulid,
  eventType: NonEmptyString,
  id: Ulid,
  occurredAt: Timestamp,
  payload: Metadata,
  principalId: Ulid,
  traceId: Schema.optional(NonEmptyString),
  version: Schema.Literal(1),
}).pipe(
  Schema.refine((record): record is typeof record => record.data.aggregateVersion >= 1, {
    message: "Identity security event aggregate versions start at one.",
  }),
);

export const IdentitySessionRecord = makeRecordSchema(
  "identity-session",
  {
    authentication: IdentitySessionAuthentication.pipe(
      Schema.withDecodingDefaultKey(Effect.succeed({ method: "password" as const })),
    ),
    authenticationTime: Timestamp,
    createdAt: Timestamp,
    /** A coarse browser and OS label such as "Chrome on macOS", never the raw user agent. */
    deviceLabel: Schema.optional(NonEmptyString),
    expiresAt: Timestamp,
    id: Ulid,
    idleExpiresAt: Timestamp,
    ipPrefixHash: Schema.optional(hash),
    lastRefreshedAt: Timestamp,
    principalId: Ulid,
    revokedAt: Schema.optional(Timestamp),
    sessionEpoch: NonNegativeSafeInteger,
    status: Schema.Literals(["active", "revoked"]),
    tokenHash: hash,
    updatedAt: Timestamp,
    userAgentHash: Schema.optional(hash),
    version: NonNegativeSafeInteger,
  },
  expires,
);

export const IdentitySessionLocatorRecord = makeRecordSchema(
  "identity-session-locator",
  {
    ...mutableResourceFields,
    expiresAt: Timestamp,
    id: Ulid,
    principalId: Ulid,
    revokedAt: Schema.optional(Timestamp),
    sessionId: Ulid,
    sessionTokenHash: hash,
    status: Schema.Literals(["active", "revoked"]),
  },
  expires,
);

export const WebBffAuthorizationTransactionRecord = makeRecordSchema(
  "web-bff-authorization-transaction",
  {
    ...mutableResourceFields,
    clientId: Schema.Literal("deployments-web"),
    consumedAt: Schema.optional(Timestamp),
    expiresAt: Timestamp,
    id: Ulid,
    nonceHash: hash,
    protectedClientState: IdentityProtectedEnvelope,
    redirectUri: NonEmptyString,
    stateHash: hash,
    status: Schema.Literals(["pending", "consumed", "expired"]),
    transactionTokenHash: hash,
  },
  expires,
);

const webBffSessionBase = {
  ...mutableResourceFields,
  clientId: Schema.Literal("deployments-web"),
  cookieTokenHash: hash,
  expiresAt: Timestamp,
  id: Ulid,
  idleExpiresAt: Timestamp,
  principalId: Ulid,
  refreshCredentialVersion: NonNegativeSafeInteger,
  sessionEpoch: NonNegativeSafeInteger,
} as const;

const ActiveIdleWebBffSessionRecord = makeRecordSchema(
  "web-bff-session",
  {
    ...webBffSessionBase,
    accessTokenExpiresAt: Timestamp,
    lastRefreshedAt: Schema.optional(Timestamp),
    protectedCredentials: IdentityProtectedEnvelope,
    refreshState: Schema.Literal("idle"),
    status: Schema.Literal("active"),
  },
  expires,
);

const ActiveLeasedWebBffSessionRecord = makeRecordSchema(
  "web-bff-session",
  {
    ...webBffSessionBase,
    accessTokenExpiresAt: Timestamp,
    lastRefreshedAt: Schema.optional(Timestamp),
    protectedCredentials: IdentityProtectedEnvelope,
    refreshLeaseExpiresAt: Timestamp,
    refreshLeaseOwnerHash: hash,
    refreshState: Schema.Literal("leased"),
    status: Schema.Literal("active"),
  },
  expires,
);

const ReauthenticationWebBffSessionRecord = makeRecordSchema(
  "web-bff-session",
  {
    ...webBffSessionBase,
    invalidatedAt: Timestamp,
    status: Schema.Literal("reauthentication-required"),
  },
  expires,
);

const RevokedWebBffSessionRecord = makeRecordSchema(
  "web-bff-session",
  {
    ...webBffSessionBase,
    revokedAt: Timestamp,
    status: Schema.Literal("revoked"),
  },
  expires,
);

export const WebBffSessionRecord = Schema.Union([
  ActiveIdleWebBffSessionRecord,
  ActiveLeasedWebBffSessionRecord,
  ReauthenticationWebBffSessionRecord,
  RevokedWebBffSessionRecord,
]);

export const OAuthClientRecord = makeRecordSchema("oauth-client", {
  ...mutableResourceFields,
  allowedScopes: scopeList,
  clientId: NonEmptyString,
  clientSecretHash: Schema.optional(hash),
  clientSecretVersionId: Schema.optional(NonEmptyString),
  grantTypes: scopeList,
  id: NonEmptyString,
  name: NonEmptyString,
  previousClientSecretHash: Schema.optional(hash),
  previousClientSecretVersionId: Schema.optional(NonEmptyString),
  previousSecretExpiresAt: Schema.optional(Timestamp),
  redirectUris: Schema.Array(NonEmptyString),
  requiredScopes: scopeList,
  requirePkce: Schema.Boolean,
  responseTypes: scopeList,
  status: Schema.Literals(["active", "disabled"]),
  tokenEndpointAuthMethod: Schema.Literals(["none", "client_secret_basic"]),
  trusted: Schema.Boolean,
  type: Schema.Literals(["public", "confidential"]),
});

export const OAuthAuthorizationRequestRecord = makeRecordSchema(
  "oauth-authorization-request",
  {
    ...mutableResourceFields,
    authenticationSessionId: Schema.optional(Ulid),
    authorizationCodeHash: Schema.optional(hash),
    clientId: NonEmptyString,
    codeChallenge: NonEmptyString,
    codeChallengeMethod: Schema.Literal("S256"),
    completedAt: Schema.optional(Timestamp),
    expiresAt: Timestamp,
    id: Ulid,
    nonce: Schema.optional(NonEmptyString),
    principalId: Schema.optional(Ulid),
    reauthenticationTokenHash: Schema.optional(hash),
    redirectUri: NonEmptyString,
    requestHandleHash: hash,
    requestedScopes: scopeList,
    responseType: Schema.Literal("code"),
    state: Schema.optional(NonEmptyString),
    status: Schema.Literals(["pending", "authenticated", "completed", "denied", "expired"]),
  },
  expires,
);

export const OAuthReauthenticationRequestRecord = makeRecordSchema(
  "oauth-reauthentication-request",
  {
    ...mutableResourceFields,
    authenticatedSessionId: Schema.optional(Ulid),
    consumedAt: Schema.optional(Timestamp),
    expiresAt: Timestamp,
    id: Ulid,
    previousSessionId: Schema.optional(Ulid),
    requestFingerprint: hash,
    status: Schema.Literals(["pending", "consumed", "expired"]),
    tokenHash: hash,
  },
  expires,
);

export const OAuthAuthorizationCodeRecord = makeRecordSchema(
  "oauth-authorization-code",
  {
    ...mutableResourceFields,
    authenticationTime: Timestamp,
    authorizationRequestId: Ulid,
    browserSessionId: Ulid,
    clientId: NonEmptyString,
    codeChallenge: NonEmptyString,
    codeChallengeMethod: Schema.Literal("S256"),
    codeHash: hash,
    consumedAt: Schema.optional(Timestamp),
    expiresAt: Timestamp,
    id: Ulid,
    nonce: Schema.optional(NonEmptyString),
    principalId: Ulid,
    redirectUri: NonEmptyString,
    scopes: scopeList,
    sessionEpoch: NonNegativeSafeInteger,
    status: Schema.Literals(["active", "consumed", "expired"]),
  },
  expires,
);

export const OAuthRefreshFamilyRecord = makeRecordSchema(
  "oauth-refresh-family",
  {
    ...mutableResourceFields,
    audience: NonEmptyString,
    authenticationTime: Timestamp,
    browserSessionId: Schema.optional(Ulid),
    clientId: NonEmptyString,
    expiresAt: Timestamp,
    id: Ulid,
    latestGeneration: NonNegativeSafeInteger,
    principalId: Ulid,
    revocationReason: Schema.optional(NonEmptyString),
    revokedAt: Schema.optional(Timestamp),
    scopes: scopeList,
    sessionEpoch: NonNegativeSafeInteger,
    status: Schema.Literals(["active", "revoked", "compromised", "expired"]),
  },
  expires,
);

export const OAuthRefreshTokenRecord = makeRecordSchema(
  "oauth-refresh-token",
  {
    ...mutableResourceFields,
    expiresAt: Timestamp,
    familyId: Ulid,
    generation: NonNegativeSafeInteger,
    id: Ulid,
    replacementTokenHash: Schema.optional(hash),
    rotatedAt: Schema.optional(Timestamp),
    status: Schema.Literals(["active", "rotated", "revoked"]),
    tokenHash: hash,
  },
  expires,
);

export const OAuthDeviceGrantRecord = makeRecordSchema(
  "oauth-device-grant",
  {
    ...mutableResourceFields,
    approvedAt: Schema.optional(Timestamp),
    approvedSessionEpoch: Schema.optional(NonNegativeSafeInteger),
    authentication: Schema.optional(IdentitySessionAuthentication),
    authenticationTime: Schema.optional(Timestamp),
    claimedBySessionId: Schema.optional(Ulid),
    clientId: NonEmptyString,
    consumedAt: Schema.optional(Timestamp),
    deniedAt: Schema.optional(Timestamp),
    deviceCodeHash: hash,
    expiresAt: Timestamp,
    id: Ulid,
    lastPolledAt: Schema.optional(Timestamp),
    nextPollAt: Schema.optional(Timestamp),
    pollingIntervalSeconds: NonNegativeSafeInteger,
    principalId: Schema.optional(Ulid),
    requestedScopes: scopeList,
    status: Schema.Literals(["pending", "claimed", "approved", "denied", "consumed", "expired"]),
    userCodeHash: hash,
  },
  expires,
);

export const IdentitySigningKeyRecord = makeRecordSchema("identity-signing-key", {
  ...mutableResourceFields,
  activatedAt: Timestamp,
  algorithm: Schema.Literal("RS256"),
  id: NonEmptyString,
  kid: NonEmptyString,
  kmsKeyArn: NonEmptyString,
  publishUntil: Schema.optional(Timestamp),
  status: Schema.Literals(["active", "retiring", "retired"]),
});

export const IDENTITY_RECORD_SCHEMAS = {
  ...FEDERATION_IDENTITY_RECORD_SCHEMAS,
  ...MFA_IDENTITY_RECORD_SCHEMAS,
  ...ACCOUNT_IDENTITY_RECORD_SCHEMAS,
  "app-login-handoff": AppLoginHandoffRecord,
  "app-login-transaction": AppLoginTransactionRecord,
  "app-session": AppSessionRecord,
  "identity-action": IdentityActionRecord,
  "identity-bff-revocation-fence": IdentityBffRevocationFenceRecord,
  "identity-public-email-request": IdentityPublicEmailRequestRecord,
  "identity-rate-limit": IdentityRateLimitRecord,
  "identity-registration": IdentityRegistrationRecord,
  "identity-session": IdentitySessionRecord,
  "identity-session-locator": IdentitySessionLocatorRecord,
  "identity-signing-key": IdentitySigningKeyRecord,
  "oauth-authorization-code": OAuthAuthorizationCodeRecord,
  "oauth-authorization-request": OAuthAuthorizationRequestRecord,
  "oauth-client": OAuthClientRecord,
  "oauth-device-grant": OAuthDeviceGrantRecord,
  "oauth-refresh-family": OAuthRefreshFamilyRecord,
  "oauth-refresh-token": OAuthRefreshTokenRecord,
  "oauth-reauthentication-request": OAuthReauthenticationRequestRecord,
  "principal-credential": PrincipalCredentialRecord,
  "principal-security-state": PrincipalSecurityStateRecord,
  "web-bff-authorization-transaction": WebBffAuthorizationTransactionRecord,
  "web-bff-session": WebBffSessionRecord,
} as const;

export const IdentityAuthRecord = Schema.Union(Object.values(IDENTITY_RECORD_SCHEMAS));
export type IdentityAuthRecord = typeof IdentityAuthRecord.Type;
