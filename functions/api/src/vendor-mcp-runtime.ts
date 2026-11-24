import { InvokeCommand } from "@aws-sdk/client-lambda";
import type { RemoteMcpAdministrationClient } from "@deployments-ai/mcp-client";
import { discoverMcpAuthorization, registerDynamicOAuthClient } from "@deployments-ai/mcp-client";
import type { OAuthRefreshRequest, OAuthRefreshResponse } from "@deployments-ai/providers";
import {
  OAUTH_REFRESH_FUNCTION_NAME_ENV,
  PLATFORM_OAUTH_PUBLIC_ORIGIN_ENV,
  parseOAuthRefreshResponse,
} from "@deployments-ai/providers";
import type { VendorMcpAdministrationDependencies } from "./vendor-mcp-dependencies.ts";

/** Minimal Lambda client surface used to invoke the channel-provider `oauth-refresh` function. */
export interface OAuthRefreshLambdaClient {
  readonly send: (command: InvokeCommand) => Promise<{
    readonly FunctionError?: string | undefined;
    readonly Payload?: Uint8Array | undefined;
  }>;
}

/** Validates `PLATFORM_OAUTH_PUBLIC_ORIGIN`: an exact HTTPS origin with no path or trailing slash. */
export function vendorMcpPublicOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${PLATFORM_OAUTH_PUBLIC_ORIGIN_ENV} must be an HTTPS origin.`);
  }
  if (url.protocol !== "https:" || url.origin !== value) {
    throw new Error(`${PLATFORM_OAUTH_PUBLIC_ORIGIN_ENV} must be an exact HTTPS origin.`);
  }
  return value;
}

/**
 * Synchronously invokes the `oauth-refresh` Lambda. A function error, transport failure, or
 * malformed payload is `retryable`: the caller cannot tell whether a refresh happened.
 */
export function makeOAuthRefreshInvoker(
  functionName: string,
  client: OAuthRefreshLambdaClient,
): (request: OAuthRefreshRequest) => Promise<OAuthRefreshResponse> {
  return async (request) => {
    try {
      const response = await client.send(
        new InvokeCommand({
          FunctionName: functionName,
          InvocationType: "RequestResponse",
          Payload: Buffer.from(JSON.stringify(request)),
        }),
      );
      if (response.FunctionError || !response.Payload) {
        return {
          code: "oauth_refresh_failed",
          message: "OAuth refresh function failed.",
          status: "retryable",
        };
      }
      return parseOAuthRefreshResponse(JSON.parse(Buffer.from(response.Payload).toString("utf8")));
    } catch {
      return {
        code: "oauth_refresh_unavailable",
        message: "OAuth refresh function could not be invoked.",
        status: "retryable",
      };
    }
  };
}

/**
 * Vendor MCP network ports for the administration API, or undefined when this deployment has
 * no public OAuth origin (vendor MCP operations then fail with `vendor_mcp_unconfigured`).
 */
export function makeVendorMcpAdministrationDependencies(input: {
  readonly lambda: OAuthRefreshLambdaClient;
  readonly mcpClient: RemoteMcpAdministrationClient;
  readonly publicOrigin: string | undefined;
  readonly refreshFunctionName: string | undefined;
}): VendorMcpAdministrationDependencies | undefined {
  if (!input.publicOrigin) return undefined;
  if (!input.refreshFunctionName) {
    throw new Error(
      `${OAUTH_REFRESH_FUNCTION_NAME_ENV} is required with ${PLATFORM_OAUTH_PUBLIC_ORIGIN_ENV}.`,
    );
  }
  return {
    discoverAuthorization: discoverMcpAuthorization,
    mcpClient: input.mcpClient,
    publicOrigin: vendorMcpPublicOrigin(input.publicOrigin),
    refreshConnection: makeOAuthRefreshInvoker(input.refreshFunctionName, input.lambda),
    registerClient: registerDynamicOAuthClient,
  };
}
