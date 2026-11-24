import { InvokeCommand, type LambdaClient } from "@aws-sdk/client-lambda";
import {
  RuntimeToolExecutionKnownFailureError,
  RuntimeToolPreparationRetryableError,
} from "@deployments-ai/agent-runtime";
import type { Ulid } from "@deployments-ai/db";
import {
  OAUTH_REFRESH_REQUEST_KIND,
  oauthConnectionNeedsRefresh,
  parseOAuthRefreshResponse,
  type OAuthRefreshRequest,
  type OAuthRefreshResponse,
} from "@deployments-ai/providers";
import type { RuntimeProviderConnection } from "./runtime-provider-binding.ts";

/** Invokes the internal `oauth-refresh` Lambda; never throws for invocation failures. */
export type RefreshProviderConnection = (
  request: OAuthRefreshRequest,
) => Promise<OAuthRefreshResponse>;

function retryable(code: string, message: string): OAuthRefreshResponse {
  return { code, message, status: "retryable" };
}

export function createLambdaOAuthRefreshInvoker(options: {
  readonly client: Pick<LambdaClient, "send">;
  readonly functionName: string;
}): RefreshProviderConnection {
  return async (request) => {
    let response;
    try {
      response = await options.client.send(
        new InvokeCommand({
          FunctionName: options.functionName,
          InvocationType: "RequestResponse",
          Payload: Buffer.from(JSON.stringify(request)),
        }),
      );
    } catch {
      return retryable("oauth_refresh_invoke_failed", "OAuth refresh could not be invoked.");
    }
    if (response.FunctionError) {
      return retryable("oauth_refresh_function_error", "OAuth refresh failed unexpectedly.");
    }
    try {
      const payload: unknown = response.Payload
        ? JSON.parse(Buffer.from(response.Payload).toString("utf8"))
        : undefined;
      return parseOAuthRefreshResponse(payload);
    } catch {
      return retryable(
        "oauth_refresh_invalid_response",
        "OAuth refresh returned an invalid response.",
      );
    }
  };
}

/**
 * Refreshes an OAuth provider connection whose access token is inside the refresh skew. Returns
 * true when the caller must re-load the connection (a newer credential generation exists).
 * Terminal refresh outcomes are known tool failures; transient ones are retryable.
 */
export async function refreshProviderConnectionIfDue(input: {
  readonly connection: RuntimeProviderConnection;
  readonly now: Date;
  readonly refresh: RefreshProviderConnection | undefined;
  readonly scope: {
    readonly environmentId: Ulid;
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
  };
  readonly toolName: string;
}): Promise<boolean> {
  const { connection } = input;
  const method = connection.data.authMethod.trim().toLowerCase();
  if (
    (method !== "oauth" && method !== "oauth2") ||
    !oauthConnectionNeedsRefresh(
      connection.data.refreshAfter === undefined
        ? {}
        : { refreshAfter: connection.data.refreshAfter },
      input.now,
    )
  ) {
    return false;
  }
  const reference = connection.data.credentialRef;
  if (!reference || !("generation" in reference)) {
    throw new RuntimeToolExecutionKnownFailureError(
      input.toolName,
      new Error("OAuth connection has no refreshable DynamoDB/KMS credential."),
    );
  }
  if (!input.refresh) {
    throw new RuntimeToolExecutionKnownFailureError(
      input.toolName,
      new Error("OAuth refresh is not configured"),
    );
  }
  let result: OAuthRefreshResponse;
  try {
    result = await input.refresh({
      connectionId: connection.data.id,
      environmentId: input.scope.environmentId,
      expectedGeneration: reference.generation,
      kind: OAUTH_REFRESH_REQUEST_KIND,
      organizationId: input.scope.organizationId,
      projectId: input.scope.projectId,
      requestedBy: "worker",
    });
  } catch (cause) {
    throw new RuntimeToolPreparationRetryableError(input.toolName, cause);
  }
  if (result.status === "retryable") {
    throw new RuntimeToolPreparationRetryableError(
      input.toolName,
      new Error(`OAuth refresh retryable (${result.code}): ${result.message}`),
    );
  }
  if (result.status === "not_refreshable" || result.status === "reauthorization_required") {
    throw new RuntimeToolExecutionKnownFailureError(
      input.toolName,
      new Error(`OAuth refresh ${result.status} (${result.code}): ${result.message}`),
    );
  }
  return true;
}
