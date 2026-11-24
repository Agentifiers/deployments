import {
  type IdentityRecord,
  type IdentityRepository,
  type IdentitySessionAuthentication,
  type PasswordSecondFactor,
  type PlatformRecord,
  type ProtectedEnvelope,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import {
  constantTimeTextEqual,
  IdentityError,
  sha256,
  type AuthenticationMethodReference,
  type OAuthClient,
  type RandomSource,
} from "@deployments-ai/identity";
import type { JwtSigner } from "./signer.ts";

export interface OAuthApplicationConfig {
  readonly accessTokenSeconds: number;
  readonly authorizationCodeSeconds: number;
  readonly authorizationRequestSeconds: number;
  readonly idTokenSeconds: number;
  readonly issuer: string;
  readonly refreshTokenSeconds: number;
  readonly resourceAudience: string;
  readonly securityNotificationSeconds?: number;
}

export interface OAuthApplicationDependencies {
  readonly encryptEmailPayload: (
    value: unknown,
    context: Readonly<Record<string, string>>,
  ) => Promise<ProtectedEnvelope>;
  readonly generateId: () => Ulid;
  readonly now?: () => Date;
  readonly random?: RandomSource;
  readonly reportSecurityNotificationFailure?: (cause: unknown) => void;
  readonly repository: IdentityRepository;
  readonly signer: JwtSigner;
}

export interface AuthenticatedBrowserSession {
  readonly authenticationTime: string;
  readonly principalId: Ulid;
  readonly sessionId: Ulid;
}

export type ClientRecord = IdentityRecord<"oauth-client">;
export const REFRESH_WRITE_ATTEMPTS = 5;

export function authenticateClient(
  record: ClientRecord,
  secret: string | undefined,
  now: () => Date,
) {
  if (record.data.tokenEndpointAuthMethod === "none") {
    if (secret) throw new IdentityError("invalid_client", "Public clients do not use a secret.");
    return;
  }
  const candidate = secret ? sha256(secret) : "0".repeat(64);
  const current = record.data.clientSecretHash ?? "1".repeat(64);
  const previous = record.data.previousClientSecretHash ?? "2".repeat(64);
  const currentMatch = constantTimeTextEqual(candidate, current);
  const previousMatch = constantTimeTextEqual(candidate, previous);
  const previousActive =
    !record.data.previousSecretExpiresAt ||
    Date.parse(record.data.previousSecretExpiresAt) > now().getTime();
  if (!currentMatch && !(previousMatch && previousActive)) {
    throw new IdentityError("invalid_client", "Client authentication failed.");
  }
}

export function activeRefreshConflict(
  token: IdentityRecord<"oauth-refresh-token"> | undefined,
  family: IdentityRecord<"oauth-refresh-family"> | undefined,
  clientId: string,
) {
  return (
    token?.data.status === "active" &&
    family?.data.status === "active" &&
    family.data.clientId === clientId
  );
}

export function refreshConflictUnavailable() {
  return new IdentityError(
    "temporarily_unavailable",
    "Refresh could not be completed because identity state kept changing.",
    { status: 503 },
  );
}

export function domainClient(record: ClientRecord): OAuthClient {
  return {
    allowedScopes: record.data.allowedScopes,
    clientId: record.data.clientId,
    grantTypes: record.data.grantTypes,
    redirectUris: record.data.redirectUris,
    requiredScopes: record.data.requiredScopes,
    requirePkce: record.data.requirePkce,
    responseTypes: record.data.responseTypes,
    status: record.data.status,
    tokenEndpointAuthMethod: record.data.tokenEndpointAuthMethod,
    type: record.data.type,
  };
}

/** The `amr` of a browser session. A recovery code is a second factor but not a one-time password. */
export function authenticationMethodReferences(
  authentication: IdentitySessionAuthentication,
): readonly AuthenticationMethodReference[] {
  if (authentication.method === "federated") return ["fed"];
  return SECOND_FACTOR_METHODS[authentication.secondFactor ?? "none"];
}

const SECOND_FACTOR_METHODS: Readonly<
  Record<PasswordSecondFactor | "none", readonly AuthenticationMethodReference[]>
> = {
  none: ["pwd"],
  "recovery-code": ["mfa", "pwd"],
  totp: ["mfa", "otp", "pwd"],
};

export function put(record: PlatformRecord): TransactionOperation {
  return { kind: "put", record };
}
