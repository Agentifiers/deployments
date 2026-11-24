import "@tanstack/react-start/server-only";
import type { BeginProviderAuthorizationResponse } from "@deployments-ai/api-contract/providers";
import { returnToUrl, type OAuthAppView, type ReturnTarget } from "../connections/oauth.ts";
import { PlatformApiError } from "../errors.ts";
import { consoleConfig } from "./config.ts";
import type { ConnectionBodyMutation } from "./connection-actions.ts";
import { callRoute } from "./platform-api.ts";
import { decodeRequestBody } from "./request-body.ts";

type AppMutation = ConnectionBodyMutation & { readonly appId: string };

export function createApp({
  accessToken,
  body,
  idempotencyKey,
  scope,
}: ConnectionBodyMutation): Promise<OAuthAppView> {
  return callRoute(
    "createProviderApplication",
    {
      body: decodeRequestBody(
        "createProviderApplication",
        "CreateProviderApplicationRequest",
        body,
      ),
      idempotencyKey,
      scope,
    },
    accessToken,
  );
}

export function rotateAppSecret({
  accessToken,
  appId,
  body,
  idempotencyKey,
  scope,
}: AppMutation): Promise<OAuthAppView> {
  return callRoute(
    "rotateProviderApplicationSecret",
    {
      body: decodeRequestBody(
        "rotateProviderApplicationSecret",
        "RotateProviderApplicationSecretRequest",
        body,
      ),
      idempotencyKey,
      path: { id: appId },
      scope,
    },
    accessToken,
  );
}

export function archiveApp({
  accessToken,
  appId,
  body,
  idempotencyKey,
  scope,
}: AppMutation): Promise<OAuthAppView> {
  return callRoute(
    "archiveProviderApplication",
    {
      body: decodeRequestBody(
        "archiveProviderApplication",
        "RevokeAdministrationResourceRequest",
        body,
      ),
      idempotencyKey,
      path: { id: appId },
      scope,
    },
    accessToken,
  );
}

/** The API refuses a longer `returnTo` as `invalid_return_to`. */
const MAX_RETURN_TO_LENGTH = 2_048;

/**
 * Starts an authorization that returns to this console. The return URL comes from the console's
 * own configuration, never from the browser, and the browser follows the authorization URL only
 * when it is HTTPS.
 */
export async function beginAuthorization({
  accessToken,
  body,
  idempotencyKey,
  scope,
  target,
}: ConnectionBodyMutation & {
  readonly target: ReturnTarget;
}): Promise<typeof BeginProviderAuthorizationResponse.Type> {
  const request = decodeRequestBody(
    "beginProviderAuthorization",
    "BeginProviderAuthorizationRequest",
    body,
  );
  const returnTo = returnToUrl(consoleConfig().publicOrigin, scope, target);
  if (returnTo.length > MAX_RETURN_TO_LENGTH) {
    throw new PlatformApiError("beginProviderAuthorization", {
      detail:
        "The provider sends you back to a URL that carries your skipped and restored grants, and these choices do not fit in it. Authorize first, then choose on the page you return to.",
      status: 400,
      title: "Too many choices to carry through the provider",
    });
  }
  const started = await callRoute(
    "beginProviderAuthorization",
    { body: { ...request, returnTo }, idempotencyKey, scope },
    accessToken,
  );
  if (
    !URL.canParse(started.authorizationUrl) ||
    new URL(started.authorizationUrl).protocol !== "https:"
  ) {
    throw new PlatformApiError("beginProviderAuthorization", {
      detail: "The platform returned an authorization URL that is not HTTPS.",
      status: 502,
      title: "Unexpected authorization URL",
    });
  }
  return started;
}
