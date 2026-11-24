import { Schema } from "effect";
import type { Ulid } from "../ids.ts";
import {
  IdentityActionRecord,
  IdentityBffRevocationFenceRecord,
  IdentityRateLimitRecord,
  IdentityPublicEmailRequestRecord,
  IdentityRegistrationRecord,
  IdentityEmailDeliveryRecord,
  IdentitySessionLocatorRecord,
  IdentitySessionRecord,
  OAuthAuthorizationCodeRecord,
  OAuthAuthorizationRequestRecord,
  OAuthDeviceGrantRecord,
  OAuthClientRecord,
  OAuthRefreshFamilyRecord,
  OAuthRefreshTokenRecord,
  OAuthReauthenticationRequestRecord,
  PrincipalCredentialRecord,
  PrincipalSecurityStateRecord,
  WebBffAuthorizationTransactionRecord,
  WebBffSessionRecord,
} from "../records/identity-auth.ts";
import { PrincipalRecord } from "../records/identity.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { IdentityProtectedEnvelope } from "../records/identity-envelope.ts";
import type { IdentitySessionAuthentication } from "../records/identity-federation.ts";

export type ProtectedEnvelope = typeof IdentityProtectedEnvelope.Type;
export type WebBffAuthorizationData = (typeof WebBffAuthorizationTransactionRecord.Type)["data"];
export type WebBffSessionData = (typeof WebBffSessionRecord.Type)["data"];

function ttl(expiresAt: string) {
  return Math.floor(Date.parse(expiresAt) / 1_000);
}

function decode<SchemaType extends Schema.ConstraintDecoder<unknown>>(
  schema: SchemaType,
  itemType: string,
  data: Readonly<Record<string, unknown>>,
  expiresAt?: string,
): SchemaType["Type"] {
  return Schema.decodeUnknownSync(schema)(
    withCanonicalRecordKeys({
      data,
      itemType,
      ...(expiresAt ? { ttl: ttl(expiresAt) } : {}),
    }),
  );
}

export function principalRecord(input: {
  readonly createdAt: string;
  readonly displayName?: string;
  readonly id: Ulid;
  readonly platformRole?: "administrator";
  readonly primaryEmail: string;
  readonly status?: "active" | "disabled" | "archived";
  readonly version?: number;
}) {
  return decode(PrincipalRecord, "principal", {
    createdAt: input.createdAt,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    id: input.id,
    kind: "human",
    ...(input.platformRole ? { platformRole: input.platformRole } : {}),
    primaryEmail: input.primaryEmail,
    status: input.status ?? "active",
    updatedAt: input.createdAt,
    version: input.version ?? 1,
  });
}

export function securityStateRecord(input: {
  readonly createdAt: string;
  readonly credentialVersion: number;
  readonly emailVerifiedAt?: string;
  readonly principalId: Ulid;
  readonly sessionEpoch: number;
  readonly verificationEmailSentAt?: string;
  readonly version: number;
}) {
  return decode(PrincipalSecurityStateRecord, "principal-security-state", {
    createdAt: input.createdAt,
    credentialVersion: input.credentialVersion,
    ...(input.emailVerifiedAt ? { emailVerifiedAt: input.emailVerifiedAt } : {}),
    id: "current",
    principalId: input.principalId,
    sessionEpoch: input.sessionEpoch,
    updatedAt: input.createdAt,
    ...(input.verificationEmailSentAt
      ? { verificationEmailSentAt: input.verificationEmailSentAt }
      : {}),
    version: input.version,
  });
}

export function bffFenceRecord(input: {
  readonly createdAt: string;
  readonly principalId: Ulid;
  readonly principalStatus: "active" | "disabled" | "archived";
  readonly sessionEpoch: number;
  readonly version: number;
}) {
  return decode(IdentityBffRevocationFenceRecord, "identity-bff-revocation-fence", {
    createdAt: input.createdAt,
    id: input.principalId,
    principalId: input.principalId,
    principalStatus: input.principalStatus,
    sessionEpoch: input.sessionEpoch,
    updatedAt: input.createdAt,
    version: input.version,
  });
}

export function identityRegistrationRecord(input: {
  readonly createdAt: string;
  readonly email: string;
  readonly emailHash: string;
  readonly expiresAt: string;
  readonly id: Ulid;
  readonly updatedAt?: string;
  readonly verificationEmailSentAt: string;
  readonly version?: number;
}) {
  return decode(
    IdentityRegistrationRecord,
    "identity-registration",
    {
      createdAt: input.createdAt,
      email: input.email,
      emailHash: input.emailHash,
      expiresAt: input.expiresAt,
      id: input.id,
      updatedAt: input.updatedAt ?? input.createdAt,
      verificationEmailSentAt: input.verificationEmailSentAt,
      version: input.version ?? 1,
    },
    input.expiresAt,
  );
}

export function identityRateLimitRecord(input: {
  readonly count: number;
  readonly consumedRequestIds?: readonly Ulid[];
  readonly expiresAt: string;
  readonly id: string;
  readonly limitKey: string;
  readonly scopeHash: string;
  readonly version: number;
  readonly window: string;
}) {
  return decode(
    IdentityRateLimitRecord,
    "identity-rate-limit",
    {
      ...input,
      ...(input.consumedRequestIds ? { consumedRequestIds: [...input.consumedRequestIds] } : {}),
    },
    input.expiresAt,
  );
}

export function publicEmailRequestRecord(input: {
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly id: Ulid;
  readonly operation: "password-recovery" | "sign-up";
}) {
  return decode(
    IdentityPublicEmailRequestRecord,
    "identity-public-email-request",
    {
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
      id: input.id,
      operation: input.operation,
      processedAt: input.createdAt,
      status: "processed",
      updatedAt: input.createdAt,
      version: 1,
    },
    input.expiresAt,
  );
}

export function actionRecord(input: {
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly id: Ulid;
  readonly issuedCredentialVersion?: number;
  readonly principalId: Ulid;
  readonly purpose: "verify-email" | "reset-password";
  readonly targetEmail?: string;
  readonly targetEmailHash?: string;
  readonly tokenHash: string;
}) {
  return decode(
    IdentityActionRecord,
    "identity-action",
    {
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
      id: input.id,
      ...(input.issuedCredentialVersion === undefined
        ? {}
        : { issuedCredentialVersion: input.issuedCredentialVersion }),
      principalId: input.principalId,
      purpose: input.purpose,
      status: "pending",
      ...(input.targetEmail ? { targetEmail: input.targetEmail } : {}),
      ...(input.targetEmailHash ? { targetEmailHash: input.targetEmailHash } : {}),
      tokenHash: input.tokenHash,
      updatedAt: input.createdAt,
      version: 1,
    },
    input.expiresAt,
  );
}

/** Fixed pending-dispatch shard (`00`–`15`) derived from an identity email delivery ID. */
export function identityEmailDeliveryShard(deliveryId: string) {
  let hash = 2_166_136_261;
  for (const byte of new TextEncoder().encode(deliveryId)) {
    hash ^= byte;
    hash = Math.imul(hash, 16_777_619);
  }
  return String((hash >>> 0) % 16).padStart(2, "0");
}

/** KMS/GCM binding a delivery's protected payload is encrypted under (the adapter adds stage). */
export function identityEmailDeliveryBinding(delivery: {
  readonly actionId?: string | undefined;
  readonly id: string;
  readonly invitationId?: string | undefined;
  readonly purpose: string;
}): Readonly<Record<string, string>> {
  return {
    ...(delivery.actionId ? { actionId: delivery.actionId } : {}),
    deliveryId: delivery.id,
    ...(delivery.invitationId ? { invitationId: delivery.invitationId } : {}),
    purpose: delivery.purpose,
  };
}

export function pendingEmailDeliveryRecord(input: {
  readonly actionId?: Ulid;
  readonly createdAt: string;
  readonly dispatchShard: string;
  readonly expiresAt: string;
  readonly id: Ulid;
  readonly invitationId?: Ulid;
  readonly nextDispatchAt?: string;
  readonly organizationId?: Ulid;
  readonly principalId: Ulid;
  readonly protectedPayload: ProtectedEnvelope;
  readonly purpose:
    | "verify-email"
    | "reset-password"
    | "password-changed"
    | "suspicious-refresh-reuse"
    | "organization-invitation"
    | "federated-identity-link"
    | "mfa-enabled"
    | "mfa-disabled"
    | "email-change-verify"
    | "email-changed"
    | "email-change-reported"
    | "account-deleted";
}) {
  return decode(
    IdentityEmailDeliveryRecord,
    "identity-email-delivery",
    {
      ...(input.actionId ? { actionId: input.actionId } : {}),
      attemptCount: 0,
      createdAt: input.createdAt,
      dispatchShard: input.dispatchShard,
      expiresAt: input.expiresAt,
      id: input.id,
      ...(input.invitationId ? { invitationId: input.invitationId } : {}),
      nextDispatchAt: input.nextDispatchAt ?? input.createdAt,
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
      principalId: input.principalId,
      protectedPayload: input.protectedPayload,
      purpose: input.purpose,
      status: "pending",
      updatedAt: input.createdAt,
      version: 1,
    },
    input.expiresAt,
  );
}

export function passwordCredentialRecord(input: {
  readonly createdAt: string;
  readonly passwordHash: string;
  readonly pepperVersion?: string;
  readonly principalId: Ulid;
  readonly version: number;
}) {
  return decode(PrincipalCredentialRecord, "principal-credential", {
    createdAt: input.createdAt,
    hashAlgorithm: "scrypt",
    hashParameters: {
      blockSize: 8,
      keyLength: 32,
      memoryCost: 131_072,
      parallelization: 1,
      saltLength: 16,
    },
    id: "password",
    kind: "password",
    passwordChangedAt: input.createdAt,
    passwordHash: input.passwordHash,
    ...(input.pepperVersion ? { pepperVersion: input.pepperVersion } : {}),
    principalId: input.principalId,
    status: "active",
    updatedAt: input.createdAt,
    version: input.version,
  });
}

export function sessionRecords(input: {
  readonly authentication: IdentitySessionAuthentication;
  readonly authenticationTime: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly id: Ulid;
  readonly idleExpiresAt: string;
  readonly ipPrefixHash?: string;
  readonly principalId: Ulid;
  readonly sessionEpoch: number;
  readonly tokenHash: string;
  readonly deviceLabel?: string;
  readonly userAgentHash?: string;
}) {
  const session = decode(
    IdentitySessionRecord,
    "identity-session",
    {
      authentication: input.authentication,
      authenticationTime: input.authenticationTime,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
      id: input.id,
      idleExpiresAt: input.idleExpiresAt,
      ...(input.ipPrefixHash ? { ipPrefixHash: input.ipPrefixHash } : {}),
      lastRefreshedAt: input.createdAt,
      principalId: input.principalId,
      sessionEpoch: input.sessionEpoch,
      status: "active",
      tokenHash: input.tokenHash,
      updatedAt: input.createdAt,
      ...(input.deviceLabel ? { deviceLabel: input.deviceLabel } : {}),
      ...(input.userAgentHash ? { userAgentHash: input.userAgentHash } : {}),
      version: 1,
    },
    input.expiresAt,
  );
  const locator = decode(
    IdentitySessionLocatorRecord,
    "identity-session-locator",
    {
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
      id: input.id,
      principalId: input.principalId,
      sessionId: input.id,
      sessionTokenHash: input.tokenHash,
      status: "active",
      updatedAt: input.createdAt,
      version: 1,
    },
    input.expiresAt,
  );
  return { locator, session };
}

export function authorizationRequestRecord(input: {
  readonly clientId: string;
  readonly codeChallenge: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly id: Ulid;
  readonly nonce?: string;
  readonly reauthenticationTokenHash?: string;
  readonly redirectUri: string;
  readonly requestHandleHash: string;
  readonly requestedScopes: readonly string[];
  readonly state?: string;
}) {
  return decode(
    OAuthAuthorizationRequestRecord,
    "oauth-authorization-request",
    {
      clientId: input.clientId,
      codeChallenge: input.codeChallenge,
      codeChallengeMethod: "S256",
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
      id: input.id,
      ...(input.nonce ? { nonce: input.nonce } : {}),
      ...(input.reauthenticationTokenHash
        ? { reauthenticationTokenHash: input.reauthenticationTokenHash }
        : {}),
      redirectUri: input.redirectUri,
      requestHandleHash: input.requestHandleHash,
      requestedScopes: input.requestedScopes,
      responseType: "code",
      ...(input.state ? { state: input.state } : {}),
      status: "pending",
      updatedAt: input.createdAt,
      version: 1,
    },
    input.expiresAt,
  );
}

export function reauthenticationRequestRecord(input: {
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly id: Ulid;
  readonly previousSessionId?: Ulid;
  readonly requestFingerprint: string;
  readonly tokenHash: string;
}) {
  return decode(
    OAuthReauthenticationRequestRecord,
    "oauth-reauthentication-request",
    {
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
      id: input.id,
      ...(input.previousSessionId ? { previousSessionId: input.previousSessionId } : {}),
      requestFingerprint: input.requestFingerprint,
      status: "pending",
      tokenHash: input.tokenHash,
      updatedAt: input.createdAt,
      version: 1,
    },
    input.expiresAt,
  );
}

export function oauthClientRecord(input: {
  readonly allowedScopes: readonly string[];
  readonly clientId: string;
  readonly clientSecretHash?: string;
  readonly clientSecretVersionId?: string;
  readonly createdAt: string;
  readonly grantTypes: readonly string[];
  readonly name: string;
  readonly redirectUris: readonly string[];
  readonly requiredScopes: readonly string[];
  readonly tokenEndpointAuthMethod: "none" | "client_secret_basic";
  readonly type: "public" | "confidential";
  readonly version: number;
}) {
  return decode(OAuthClientRecord, "oauth-client", {
    allowedScopes: input.allowedScopes,
    clientId: input.clientId,
    ...(input.clientSecretHash ? { clientSecretHash: input.clientSecretHash } : {}),
    ...(input.clientSecretVersionId ? { clientSecretVersionId: input.clientSecretVersionId } : {}),
    createdAt: input.createdAt,
    grantTypes: input.grantTypes,
    id: input.clientId,
    name: input.name,
    redirectUris: input.redirectUris,
    requiredScopes: input.requiredScopes,
    requirePkce: true,
    responseTypes: ["code"],
    status: "active",
    tokenEndpointAuthMethod: input.tokenEndpointAuthMethod,
    trusted: true,
    type: input.type,
    updatedAt: input.createdAt,
    version: input.version,
  });
}

export function authorizationCodeRecord(input: {
  readonly authenticationTime: string;
  readonly authorizationRequestId: Ulid;
  readonly browserSessionId: Ulid;
  readonly clientId: string;
  readonly codeChallenge: string;
  readonly codeHash: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly id: Ulid;
  readonly nonce?: string;
  readonly principalId: Ulid;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly sessionEpoch: number;
}) {
  return decode(
    OAuthAuthorizationCodeRecord,
    "oauth-authorization-code",
    {
      authenticationTime: input.authenticationTime,
      authorizationRequestId: input.authorizationRequestId,
      browserSessionId: input.browserSessionId,
      clientId: input.clientId,
      codeChallenge: input.codeChallenge,
      codeChallengeMethod: "S256",
      codeHash: input.codeHash,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
      id: input.id,
      ...(input.nonce ? { nonce: input.nonce } : {}),
      principalId: input.principalId,
      redirectUri: input.redirectUri,
      scopes: input.scopes,
      sessionEpoch: input.sessionEpoch,
      status: "active",
      updatedAt: input.createdAt,
      version: 1,
    },
    input.expiresAt,
  );
}

export function refreshRecords(input: {
  readonly audience: string;
  readonly authenticationTime: string;
  readonly browserSessionId?: Ulid;
  readonly clientId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly familyId: Ulid;
  readonly principalId: Ulid;
  readonly scopes: readonly string[];
  readonly sessionEpoch: number;
  readonly tokenHash: string;
  readonly tokenId: Ulid;
}) {
  const family = decode(
    OAuthRefreshFamilyRecord,
    "oauth-refresh-family",
    {
      audience: input.audience,
      authenticationTime: input.authenticationTime,
      ...(input.browserSessionId ? { browserSessionId: input.browserSessionId } : {}),
      clientId: input.clientId,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
      id: input.familyId,
      latestGeneration: 1,
      principalId: input.principalId,
      scopes: input.scopes,
      sessionEpoch: input.sessionEpoch,
      status: "active",
      updatedAt: input.createdAt,
      version: 1,
    },
    input.expiresAt,
  );
  const token = decode(
    OAuthRefreshTokenRecord,
    "oauth-refresh-token",
    {
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
      familyId: input.familyId,
      generation: 1,
      id: input.tokenId,
      status: "active",
      tokenHash: input.tokenHash,
      updatedAt: input.createdAt,
      version: 1,
    },
    input.expiresAt,
  );
  return { family, token };
}

export function deviceGrantRecord(input: {
  readonly clientId: string;
  readonly createdAt: string;
  readonly deviceCodeHash: string;
  readonly expiresAt: string;
  readonly id: Ulid;
  readonly pollingIntervalSeconds: number;
  readonly requestedScopes: readonly string[];
  readonly userCodeHash: string;
}) {
  return decode(
    OAuthDeviceGrantRecord,
    "oauth-device-grant",
    {
      clientId: input.clientId,
      createdAt: input.createdAt,
      deviceCodeHash: input.deviceCodeHash,
      expiresAt: input.expiresAt,
      id: input.id,
      pollingIntervalSeconds: input.pollingIntervalSeconds,
      requestedScopes: input.requestedScopes,
      status: "pending",
      updatedAt: input.createdAt,
      userCodeHash: input.userCodeHash,
      version: 1,
    },
    input.expiresAt,
  );
}

/** Validates one complete authorization-transaction state as a canonical full-record put. */
export function webBffAuthorizationRecord(data: WebBffAuthorizationData) {
  return decode(
    WebBffAuthorizationTransactionRecord,
    "web-bff-authorization-transaction",
    data,
    data.expiresAt,
  );
}

/** Validates one complete BFF session union member as a canonical full-record put. */
export function webBffSessionRecord(data: WebBffSessionData) {
  return decode(WebBffSessionRecord, "web-bff-session", data, data.expiresAt);
}
