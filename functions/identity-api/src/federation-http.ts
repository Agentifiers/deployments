import { requestSource, type Ulid } from "@deployments-ai/db";
import { IdentityError } from "@deployments-ai/identity";
import { safeReturnTo } from "./authorize-continuation.ts";
import type { FederationApplication } from "./federation-application.ts";
import {
  callbackResponse,
  federationCookies,
  optionalText,
  requiredText,
} from "./federation-responses.ts";
import { json, type RestApiResponse } from "./http-responses.ts";
import { samlResponse } from "./saml-http.ts";

const DISCOVER_PATH = "/v1/auth/federation/discover";
const START_PATH = "/v1/auth/federation/start";
const LINK_REQUEST_PATH = "/v1/auth/federation/link-request";
const CONFIRM_LINK_PATH = "/v1/auth/federation/confirm-link";
const INVALID_LINK = "This confirmation link is invalid or has expired.";
const CALLBACK_PATH = /^\/oauth2\/federation\/callback\/([^/]+)$/u;

export interface FederationRouteRequest {
  /** The principal of the browser's identity session, if it has one. */
  readonly browserPrincipalId: () => Promise<Ulid | undefined>;
  readonly cookies: Readonly<Record<string, string>>;
  readonly csrfCookieName: string;
  readonly ipPrefixHash: string | undefined;
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string | undefined>>;
  readonly readBody: () => Record<string, unknown>;
  /** Form-encoded only and never repeated; 413 above `maxBytes`. */
  readonly readForm: (maxBytes: number) => Readonly<Record<string, string>>;
  readonly secureCookies: boolean;
  readonly sessionCookieName: string;
  readonly deviceLabel: string | undefined;
  readonly userAgentHash: string | undefined;
}

export async function federationResponse(
  federation: FederationApplication | undefined,
  request: FederationRouteRequest,
): Promise<RestApiResponse | undefined> {
  if (!federation) return undefined;
  const cookies = federationCookies(request);
  const saml = await samlResponse(federation, request, cookies);
  if (saml) return saml;
  if (request.method === "POST" && request.path === DISCOVER_PATH) {
    return json(200, await federation.discover(requiredText(request.readBody(), "email")));
  }
  if (request.method === "POST" && request.path === START_PATH) {
    const body = request.readBody();
    const loginHint = optionalText(body, "loginHint");
    const started = await federation.start({
      ...(loginHint ? { loginHint } : {}),
      organizationId: requiredText(body, "organizationId"),
      returnTo: safeReturnTo(optionalText(body, "returnTo")),
    });
    if (!started) {
      throw new IdentityError(
        "invalid_request",
        "Single sign-on is not available for this organization.",
        { exposeDescription: true, status: 404 },
      );
    }
    const binding = started.protocol === "saml" ? cookies.crossSiteBinding : cookies.binding;
    return {
      ...json(200, { location: started.location }),
      multiValueHeaders: {
        "Set-Cookie": [binding(started.bindingToken, started.bindingMaxAgeSeconds)],
      },
    };
  }
  if (request.method === "POST" && request.path === LINK_REQUEST_PATH) {
    const link = await federation.pendingLink(requiredText(request.readBody(), "token"));
    if (!link) {
      throw new IdentityError("invalid_request", INVALID_LINK, { exposeDescription: true });
    }
    return json(200, link);
  }
  if (request.method === "POST" && request.path === CONFIRM_LINK_PATH) {
    const confirmed = await federation.confirmLink({
      bindingToken: request.cookies[cookies.bindingCookieName],
      token: requiredText(request.readBody(), "token"),
    });
    switch (confirmed.kind) {
      case "linked":
        return {
          ...json(200, confirmed),
          multiValueHeaders: { "Set-Cookie": [cookies.binding("", 0)] },
        };
      case "browser-mismatch":
        throw new IdentityError(
          "access_denied",
          "Open this link in the browser where you signed in with your identity provider.",
          { exposeDescription: true, status: 403 },
        );
      case "invalid":
        throw new IdentityError("invalid_request", INVALID_LINK, { exposeDescription: true });
      default: {
        const unhandled: never = confirmed;
        return unhandled;
      }
    }
  }
  const organizationId =
    request.method === "GET" ? CALLBACK_PATH.exec(request.path)?.[1] : undefined;
  if (organizationId === undefined) return undefined;
  const outcome = await federation.callback({
    bindingToken: request.cookies[cookies.bindingCookieName],
    organizationId,
    query: request.query,
    ...requestSource(request),
  });
  return callbackResponse(outcome, cookies, 302);
}
