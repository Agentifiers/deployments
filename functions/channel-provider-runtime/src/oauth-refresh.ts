import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  makeDynamoDatabase,
  makeOAuthRefreshClaimPersistence,
  ProviderConnectionRecord,
  type OAuthRefreshClaimPersistence,
  type Ulid,
} from "@deployments-ai/db";
import {
  OAUTH_REFRESH_REQUEST_KIND,
  parseOAuthRefreshRequest,
  type OAuthRefreshRequest,
  type OAuthRefreshResponse,
} from "@deployments-ai/providers";
import { Schema } from "effect";
import { randomUUID } from "node:crypto";

import type { ProviderConnection } from "./oauth-authorization-commit.ts";
import {
  classifyOAuthRefreshFailure,
  refreshProviderConnection,
} from "./oauth-connection-lifecycle.ts";
import {
  defaultOAuthRuntimeDependencies,
  type OAuthRuntimeDependencies,
  type OAuthScope,
} from "./oauth-runtime-dependencies.ts";
import { OAuthRecordNotFoundError, response, type OAuthHttpResponse } from "./oauth-validation.ts";
import { vaultReference } from "./runtime.ts";

/** Lease of one refresher over one credential generation. */
const OAUTH_REFRESH_CLAIM_LEASE_MS = 30_000;
export const OAUTH_REFRESH_POLL_INTERVAL_MS = 250;
const OAUTH_REFRESH_POLL_TIMEOUT_MS = 10_000;

export interface OAuthRefreshDependencies extends OAuthRuntimeDependencies {
  readonly claims: OAuthRefreshClaimPersistence;
  readonly sleep: (ms: number) => Promise<void>;
}

/** `refresh`: the connection is active at exactly the expected generation. */
type Settled = OAuthRefreshResponse | "wait" | { readonly refresh: ProviderConnection };

function connectionReference(connection: ProviderConnection) {
  return connection.data.credentialRef ? vaultReference(connection.data.credentialRef) : undefined;
}

/**
 * Decides whether a connection still needs a refresh from `expectedGeneration`, has
 * already advanced (`current`), or can no longer be refreshed. `wait` marks a newer
 * generation that is not yet active (a platform two-phase rotation in flight).
 */
function settle(connection: ProviderConnection | undefined, expectedGeneration: number): Settled {
  if (!connection) {
    return {
      code: "connection_not_found",
      message: "Provider connection was not found.",
      status: "not_refreshable",
    };
  }
  const reference = connectionReference(connection);
  if (connection.data.authMethod !== "oauth" || !reference) {
    return {
      code: "connection_not_oauth",
      message: "Provider connection does not hold an OAuth credential.",
      status: "not_refreshable",
    };
  }
  if (connection.data.status === "active" && reference.generation > expectedGeneration) {
    return {
      reference,
      ...(connection.data.refreshAfter ? { refreshAfter: connection.data.refreshAfter } : {}),
      status: "current",
    };
  }
  if (connection.data.status === "reauthorization-required") {
    return reference.generation > expectedGeneration
      ? "wait"
      : {
          code: "connection_reauthorization_required",
          message: "Provider connection must be re-authorized.",
          status: "reauthorization_required",
        };
  }
  if (connection.data.status !== "active") {
    return {
      code: "connection_not_active",
      message: "Provider connection is not active.",
      status: "not_refreshable",
    };
  }
  return reference.generation === expectedGeneration
    ? { refresh: connection }
    : {
        code: "generation_ahead_of_connection",
        message: "Expected credential generation is newer than the connection's credential.",
        status: "retryable",
      };
}

async function loadConnection(
  dependencies: OAuthRefreshDependencies,
  scope: OAuthScope,
  connectionId: string,
) {
  try {
    return Schema.decodeUnknownSync(ProviderConnectionRecord)(
      await dependencies.loadControlRecord(scope, "provider-connection", connectionId),
    );
  } catch (cause) {
    if (cause instanceof OAuthRecordNotFoundError) return undefined;
    throw cause;
  }
}

/** Polls for another refresher to advance the credential past `expectedGeneration`. */
async function awaitConcurrentRefresh(
  dependencies: OAuthRefreshDependencies,
  scope: OAuthScope,
  request: OAuthRefreshRequest,
): Promise<OAuthRefreshResponse> {
  const deadline = dependencies.now().getTime() + OAUTH_REFRESH_POLL_TIMEOUT_MS;
  while (dependencies.now().getTime() < deadline) {
    await dependencies.sleep(OAUTH_REFRESH_POLL_INTERVAL_MS);
    const settled = settle(
      await loadConnection(dependencies, scope, request.connectionId),
      request.expectedGeneration,
    );
    if (settled !== "wait" && !("refresh" in settled)) return settled;
  }
  return {
    code: "refresh_in_progress",
    message: "Another refresher still holds this credential generation.",
    status: "retryable",
  };
}

async function refreshClaimed(
  dependencies: OAuthRefreshDependencies,
  scope: OAuthScope,
  request: OAuthRefreshRequest,
): Promise<OAuthRefreshResponse> {
  // A refresher that completed between the first read and the claim released a claim
  // keyed by the old generation, so re-read before spending the refresh token.
  const settled = settle(
    await loadConnection(dependencies, scope, request.connectionId),
    request.expectedGeneration,
  );
  if (settled === "wait") return awaitConcurrentRefresh(dependencies, scope, request);
  if (!("refresh" in settled)) return settled;
  const connection = settled.refresh;
  try {
    const refreshed = await refreshProviderConnection(dependencies, scope, connection);
    return {
      reference: refreshed.reference,
      ...(refreshed.refreshAfter ? { refreshAfter: refreshed.refreshAfter } : {}),
      status: "refreshed",
    };
  } catch (cause) {
    const failure = classifyOAuthRefreshFailure(cause);
    console.warn("OAuth connection refresh failed.", {
      code: failure.code,
      errorType: cause instanceof Error ? cause.name : "UnknownError",
      status: failure.status,
    });
    const credentialRef = connectionReference(connection);
    if (failure.code === "oauth_refresh_rejected" && credentialRef) {
      // A refresher whose lease lapsed can lose to one that already rotated the token; the
      // provider then rejects the spent refresh token although the connection is healthy.
      const latest = settle(
        await loadConnection(dependencies, scope, request.connectionId),
        request.expectedGeneration,
      );
      if (latest === "wait") return awaitConcurrentRefresh(dependencies, scope, request);
      if (!("refresh" in latest)) return latest;
      await dependencies
        .markReauthorizationRequired({ connectionId: connection.data.id, credentialRef, scope })
        .catch((markCause: unknown) => {
          console.warn("OAuth connection could not be marked for reauthorization.", {
            errorType: markCause instanceof Error ? markCause.name : "UnknownError",
          });
        });
    }
    return { code: failure.code, message: failure.message, status: failure.status };
  }
}

/**
 * JWT `POST /provider-connections/{connectionId}` refresh: the same claimed, single-flight
 * refresh as the internal Lambda, keyed by the connection's current credential generation.
 */
export async function refreshOAuthConnectionRoute(
  dependencies: OAuthRefreshDependencies,
  scope: OAuthScope,
  connection: ProviderConnection,
  owner: string,
): Promise<OAuthHttpResponse> {
  const reference = connectionReference(connection);
  if (!reference) throw new Error("OAuth connection is incomplete.");
  const result = await refreshOAuthConnection(
    {
      ...scope,
      connectionId: connection.data.id,
      expectedGeneration: reference.generation,
      kind: OAUTH_REFRESH_REQUEST_KIND,
      requestedBy: "api",
    },
    dependencies,
    owner,
  );
  switch (result.status) {
    case "current":
    case "refreshed":
      return response(200, { reference: result.reference });
    case "reauthorization_required":
      return response(409, { error: result.code });
    case "not_refreshable":
      return response(400, { error: result.code });
    case "retryable":
      return response(503, { error: result.code });
  }
}

/**
 * Serialized on-demand refresh: returns the current reference when another refresher
 * already advanced the credential, otherwise claims the generation and rotates once.
 */
export async function refreshOAuthConnection(
  request: OAuthRefreshRequest,
  dependencies: OAuthRefreshDependencies,
  owner: string,
): Promise<OAuthRefreshResponse> {
  const scope = {
    environmentId: request.environmentId,
    organizationId: request.organizationId,
    projectId: request.projectId,
  };
  const settled = settle(
    await loadConnection(dependencies, scope, request.connectionId),
    request.expectedGeneration,
  );
  if (settled === "wait") return awaitConcurrentRefresh(dependencies, scope, request);
  if (!("refresh" in settled)) return settled;
  const target = {
    connectionId: request.connectionId as Ulid,
    credentialGeneration: request.expectedGeneration,
    environmentId: request.environmentId as Ulid,
    organizationId: request.organizationId as Ulid,
    owner,
    projectId: request.projectId as Ulid,
  };
  const claim = await dependencies.claims.acquire({
    ...target,
    leaseMs: OAUTH_REFRESH_CLAIM_LEASE_MS,
    now: dependencies.now(),
  });
  if (claim === "held") return awaitConcurrentRefresh(dependencies, scope, request);
  try {
    return await refreshClaimed(dependencies, scope, request);
  } finally {
    await dependencies.claims.release(target).catch((cause: unknown) => {
      console.warn("OAuth refresh claim release failed; the lease will expire.", {
        errorType: cause instanceof Error ? cause.name : "UnknownError",
      });
    });
  }
}

let claimClient: DynamoDBDocumentClient | undefined;

export function defaultRefreshDependencies(): OAuthRefreshDependencies {
  // Claims live in the execution table and use the function's own role; vault and
  // connection access go through the scoped writer role.
  claimClient ??= DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return {
    ...defaultOAuthRuntimeDependencies(),
    claims: makeOAuthRefreshClaimPersistence(
      makeDynamoDatabase(claimClient, {
        control: process.env.DEPLOYMENTS_AI_CONTROL_TABLE ?? "control",
        events: process.env.DEPLOYMENTS_AI_EVENTS_TABLE ?? "events",
        execution: process.env.DEPLOYMENTS_AI_EXECUTION_TABLE ?? "execution",
        usage: process.env.DEPLOYMENTS_AI_USAGE_TABLE ?? "usage",
      }),
    ),
    sleep: (ms) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, ms);
      return promise;
    },
  };
}

/** IAM-invoked `oauth-refresh` Lambda (no JWT); see `OAuthRefreshRequest`. */
export async function handler(
  event: unknown,
  context?: { readonly awsRequestId?: string },
): Promise<OAuthRefreshResponse> {
  return refreshOAuthConnection(
    parseOAuthRefreshRequest(event),
    defaultRefreshDependencies(),
    context?.awsRequestId ?? randomUUID(),
  );
}
