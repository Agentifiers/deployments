import { requestSource } from "@deployments-ai/db";
import { IdentityError, randomToken } from "@deployments-ai/identity";
import { federationConfirmSignInUi } from "./federation-confirm-ui.ts";
import type { FederationRouteRequest } from "./federation-http.ts";
import {
  callbackPage,
  callbackResponse,
  REJECTIONS,
  requiredText,
  type FederationCookies,
} from "./federation-responses.ts";
import { json, redirect, securityHeaders, type RestApiResponse } from "./http-responses.ts";
import {
  SAML_RESPONSE_BYTE_LIMIT,
  type SamlApplication,
  type UnsolicitedSignInStep,
} from "./saml-application.ts";

const ACS_PATH = /^\/saml\/([^/]+)\/acs$/u;
const METADATA_PATH = /^\/saml\/([^/]+)\/metadata$/u;
const CONFIRM_SIGN_IN_PAGE = "/federation/confirm-sign-in";
const RESUME_PATH = "/v1/auth/federation/unsolicited/resume";
const CONFIRM_PATH = "/v1/auth/federation/unsolicited/confirm";
const INVALID_SIGN_IN = "This sign-in link is invalid or has expired.";

function stepResponse(step: UnsolicitedSignInStep, cookies: FederationCookies): RestApiResponse {
  switch (step.kind) {
    case "signed-in":
      return {
        ...json(200, { kind: "signed-in", location: step.returnTo }),
        multiValueHeaders: { "Set-Cookie": [cookies.session(step.sessionToken)] },
      };
    case "confirmation-required":
      return json(200, { kind: "confirm", ...step.summary });
    case "mailbox-confirmation-sent":
      // The Continue POST is same-site, so this binding needs only SameSite=Lax.
      return {
        ...json(200, { kind: step.kind, maskedEmail: step.maskedEmail }),
        multiValueHeaders: {
          "Set-Cookie": [cookies.binding(step.bindingToken, step.bindingMaxAgeSeconds)],
        },
      };
    case "rejected": {
      const { message, statusCode } = REJECTIONS[step.reason];
      throw new IdentityError("access_denied", message, {
        exposeDescription: true,
        status: statusCode,
      });
    }
    case "invalid":
      throw new IdentityError("invalid_request", INVALID_SIGN_IN, { exposeDescription: true });
    default: {
      const unhandled: never = step;
      return unhandled;
    }
  }
}

/** The ACS and metadata sit outside `/v1`: the IdP, not our page, sends the browser there. */
export async function samlResponse(
  saml: SamlApplication,
  request: FederationRouteRequest,
  cookies: FederationCookies,
): Promise<RestApiResponse | undefined> {
  const { method, path } = request;
  if (method === "GET" && path === CONFIRM_SIGN_IN_PAGE) {
    return federationConfirmSignInUi({
      csrf: randomToken(),
      csrfCookieName: request.csrfCookieName,
      secure: request.secureCookies,
    });
  }
  if (method === "POST" && path === RESUME_PATH) {
    const token = requiredText(request.readBody(), "token");
    const step = await saml.resumeUnsolicitedSignIn({
      browserPrincipalId: await request.browserPrincipalId(),
      token,
      ...requestSource(request),
    });
    return stepResponse(step, cookies);
  }
  if (method === "POST" && path === CONFIRM_PATH) {
    const token = requiredText(request.readBody(), "token");
    const step = await saml.confirmUnsolicitedSignIn({ token, ...requestSource(request) });
    return stepResponse(step, cookies);
  }
  const acsOrganization = method === "POST" ? ACS_PATH.exec(path)?.[1] : undefined;
  if (acsOrganization !== undefined) {
    const outcome = await saml.acs({
      bindingToken: request.cookies[cookies.bindingCookieName],
      form: request.readForm(SAML_RESPONSE_BYTE_LIMIT),
      organizationId: acsOrganization,
      ...requestSource(request),
    });
    switch (outcome.kind) {
      case "confirmation-required":
        return redirect(`${CONFIRM_SIGN_IN_PAGE}#token=${encodeURIComponent(outcome.token)}`, 303);
      case "consumed":
        return callbackResponse(outcome.outcome, cookies, 303);
      case "refused":
        return callbackPage(outcome.refusal);
      default: {
        const unhandled: never = outcome;
        return unhandled;
      }
    }
  }
  const metadataOrganization = method === "GET" ? METADATA_PATH.exec(path)?.[1] : undefined;
  const metadata =
    metadataOrganization === undefined
      ? undefined
      : saml.serviceProviderMetadata(metadataOrganization);
  if (metadata === undefined) return undefined;
  return {
    body: metadata,
    headers: securityHeaders("application/samlmetadata+xml"),
    isBase64Encoded: false,
    statusCode: 200,
  };
}
