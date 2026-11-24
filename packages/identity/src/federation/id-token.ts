import { errors, jwtVerify, type JWTPayload } from "jose";

import { constantTimeTextEqual } from "../crypto.ts";
import type { FederationConnection } from "./discovery.ts";
import { FederationError, type FederationErrorCode } from "./errors.ts";
import type { FederationJwksCache } from "./jwks.ts";
import { federationProfile, type FederationProfile } from "./profile.ts";

const CLOCK_TOLERANCE_SECONDS = 60;
const MAXIMUM_TOKEN_AGE_SECONDS = 10 * 60;

export interface VerifiedIdTokenClaims extends FederationProfile {
  readonly issuer: string;
  readonly subject: string;
  readonly entraEmailDomainOwnerVerified?: boolean;
  readonly authenticatedAt?: Date;
  readonly issuedAt: Date;
}

const FAILED_CLAIM_CHECKS: Readonly<Record<string, FederationErrorCode | undefined>> = {
  aud: "id_token_audience_mismatch",
  iat: "id_token_not_yet_valid",
  iss: "id_token_issuer_mismatch",
  nbf: "id_token_not_yet_valid",
};

function verificationFailure(error: unknown): FederationError {
  if (error instanceof FederationError) return error;
  if (error instanceof errors.JWTExpired) {
    return new FederationError(error.claim === "iat" ? "id_token_stale" : "id_token_expired");
  }
  if (error instanceof errors.JWTClaimValidationFailed) {
    const code = error.reason === "check_failed" ? FAILED_CLAIM_CHECKS[error.claim] : undefined;
    return new FederationError(code ?? "id_token_claims_invalid");
  }
  return new FederationError("id_token_signature_invalid");
}

function numericDate(value: unknown): Date | undefined {
  if (typeof value !== "number") return undefined;
  const date = new Date(value * 1_000);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export async function verifyFederationIdToken(input: {
  readonly connection: FederationConnection;
  readonly idToken: string;
  readonly nonce: string;
  readonly jwks: FederationJwksCache;
  readonly now: Date;
  readonly forceLoginSince?: Date;
}): Promise<VerifiedIdTokenClaims> {
  const { connection } = input;
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(
      input.idToken,
      input.jwks.keyResolver(connection.endpoints.jwks),
      {
        algorithms: [...connection.signingAlgorithms],
        audience: connection.clientId,
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
        currentDate: input.now,
        issuer: connection.issuer,
        maxTokenAge: MAXIMUM_TOKEN_AGE_SECONDS,
        requiredClaims: ["exp"],
      },
    ));
  } catch (error) {
    throw verificationFailure(error);
  }

  const multipleAudiences = Array.isArray(payload.aud) && payload.aud.length > 1;
  if ((payload.azp !== undefined || multipleAudiences) && payload.azp !== connection.clientId) {
    throw new FederationError("id_token_audience_mismatch");
  }
  if (typeof payload.nonce !== "string" || !constantTimeTextEqual(payload.nonce, input.nonce)) {
    throw new FederationError("id_token_nonce_mismatch");
  }
  const subject = payload.sub;
  const issuedAt = numericDate(payload.iat);
  if (typeof subject !== "string" || subject === "" || issuedAt === undefined) {
    throw new FederationError("id_token_claims_invalid");
  }
  const authenticatedAt = numericDate(payload.auth_time);
  if (
    input.forceLoginSince !== undefined &&
    !(
      authenticatedAt !== undefined &&
      authenticatedAt.getTime() >= input.forceLoginSince.getTime() - CLOCK_TOLERANCE_SECONDS * 1_000
    )
  ) {
    throw new FederationError("id_token_reauthentication_missing");
  }

  return {
    issuer: connection.issuer,
    subject,
    ...federationProfile(payload),
    ...(typeof payload.xms_edov === "boolean"
      ? { entraEmailDomainOwnerVerified: payload.xms_edov }
      : {}),
    ...(authenticatedAt === undefined ? {} : { authenticatedAt }),
    issuedAt,
  };
}
