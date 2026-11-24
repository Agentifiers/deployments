import { isRecord } from "./platform-oauth-config.ts";
import { PLATFORM_OAUTH_REFRESH_SKEW_MS } from "./platform-oauth-types.ts";

/**
 * Internal contract for on-demand provider OAuth refresh.
 *
 * Runtimes that only hold vault reader access (agent worker, administration API) invoke the
 * channel-provider `oauth-refresh` Lambda, which owns the vault writer role, serializes
 * concurrent refreshers with a generation-keyed claim, and performs the token exchange.
 */

export const OAUTH_REFRESH_FUNCTION_NAME_ENV = "DEPLOYMENTS_AI_OAUTH_REFRESH_FUNCTION_NAME";

export const OAUTH_REFRESH_REQUEST_KIND = "provider-connection-oauth-refresh";

export interface OAuthRefreshRequest {
  readonly connectionId: string;
  readonly environmentId: string;
  readonly expectedGeneration: number;
  readonly kind: typeof OAUTH_REFRESH_REQUEST_KIND;
  readonly organizationId: string;
  readonly projectId: string;
  readonly requestedBy: "api" | "worker";
}

export interface OAuthRefreshCredentialReference {
  readonly credentialId: string;
  readonly generation: number;
  readonly store: "dynamodb-kms";
}

export type OAuthRefreshResponse =
  | {
      readonly reference: OAuthRefreshCredentialReference;
      readonly refreshAfter?: string;
      /** `current`: another refresher already advanced past the expected generation. */
      readonly status: "current" | "refreshed";
    }
  | {
      readonly code: string;
      readonly message: string;
      /** Terminal for this credential: the connection must be re-authorized. */
      readonly status: "not_refreshable" | "reauthorization_required";
    }
  | {
      readonly code: string;
      readonly message: string;
      readonly status: "retryable";
    };

export class OAuthRefreshContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OAuthRefreshContractError";
  }
}

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_MESSAGE_LENGTH = 512;

function ulid(value: unknown, label: string): string {
  if (typeof value !== "string" || !ULID_PATTERN.test(value)) {
    throw new OAuthRefreshContractError(`${label} must be a ULID.`);
  }
  return value;
}

function generation(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new OAuthRefreshContractError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function boundedText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new OAuthRefreshContractError(`${label} must be a non-empty string.`);
  }
  return value.slice(0, MAX_MESSAGE_LENGTH);
}

export function parseOAuthRefreshRequest(value: unknown): OAuthRefreshRequest {
  if (!isRecord(value) || value.kind !== OAUTH_REFRESH_REQUEST_KIND) {
    throw new OAuthRefreshContractError("OAuth refresh request kind is invalid.");
  }
  if (value.requestedBy !== "api" && value.requestedBy !== "worker") {
    throw new OAuthRefreshContractError("OAuth refresh request requestedBy is invalid.");
  }
  return {
    connectionId: ulid(value.connectionId, "connectionId"),
    environmentId: ulid(value.environmentId, "environmentId"),
    expectedGeneration: generation(value.expectedGeneration, "expectedGeneration"),
    kind: OAUTH_REFRESH_REQUEST_KIND,
    organizationId: ulid(value.organizationId, "organizationId"),
    projectId: ulid(value.projectId, "projectId"),
    requestedBy: value.requestedBy,
  };
}

export function parseOAuthRefreshResponse(value: unknown): OAuthRefreshResponse {
  if (!isRecord(value)) {
    throw new OAuthRefreshContractError("OAuth refresh response must be an object.");
  }
  if (value.status === "current" || value.status === "refreshed") {
    const reference = value.reference;
    if (!isRecord(reference) || reference.store !== "dynamodb-kms") {
      throw new OAuthRefreshContractError("OAuth refresh response reference is invalid.");
    }
    const refreshAfter = value.refreshAfter;
    if (
      refreshAfter !== undefined &&
      (typeof refreshAfter !== "string" || Number.isNaN(Date.parse(refreshAfter)))
    ) {
      throw new OAuthRefreshContractError("OAuth refresh response refreshAfter is invalid.");
    }
    return {
      reference: {
        credentialId: ulid(reference.credentialId, "reference.credentialId"),
        generation: generation(reference.generation, "reference.generation"),
        store: "dynamodb-kms",
      },
      ...(refreshAfter !== undefined ? { refreshAfter } : {}),
      status: value.status,
    };
  }
  if (
    value.status === "not_refreshable" ||
    value.status === "reauthorization_required" ||
    value.status === "retryable"
  ) {
    return {
      code: boundedText(value.code, "code"),
      message: boundedText(value.message, "message"),
      status: value.status,
    };
  }
  throw new OAuthRefreshContractError("OAuth refresh response status is invalid.");
}

/** True when an OAuth connection's access token expires within the refresh skew. */
export function oauthConnectionNeedsRefresh(
  connection: { readonly refreshAfter?: string },
  now: Date,
): boolean {
  if (!connection.refreshAfter) return false;
  const expiresAt = Date.parse(connection.refreshAfter);
  return Number.isNaN(expiresAt) || expiresAt - PLATFORM_OAUTH_REFRESH_SKEW_MS <= now.getTime();
}
