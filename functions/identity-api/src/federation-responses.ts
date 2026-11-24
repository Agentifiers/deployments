import { IdentityError } from "@deployments-ai/identity";
import type {
  FederationCallbackOutcome,
  FederationCallbackRejection,
} from "./federation-completion.ts";
import { cookie, redirect, type RestApiResponse } from "./http-responses.ts";
import { federationMessageUi } from "./identity-ui.ts";

const SESSION_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export const REJECTIONS: Readonly<
  Record<FederationCallbackRejection, { readonly message: string; readonly statusCode: number }>
> = {
  assertion_replayed: {
    message: "This sign-in response was already used. Start again from your identity provider.",
    statusCode: 400,
  },
  binding_missing: {
    message:
      "This sign-in expired or was started in another browser. Start again from the sign-in page.",
    statusCode: 400,
  },
  connection_changed: {
    message:
      "Your organization changed its identity provider while you were signing in. Start again from the sign-in page.",
    statusCode: 409,
  },
  connection_inactive: {
    message: "Single sign-on is turned off for your organization.",
    statusCode: 403,
  },
  email_domain_not_verified: {
    message: "Your email domain is not verified for single sign-on with this organization.",
    statusCode: 403,
  },
  email_missing: {
    message: "Your identity provider did not share an email address.",
    statusCode: 403,
  },
  email_unverified: {
    message: "Your identity provider has not verified your email address.",
    statusCode: 403,
  },
  hosted_domain_mismatch: {
    message: "Your Google account does not belong to your organization's domain.",
    statusCode: 403,
  },
  issuer_mismatch: {
    message: "The sign-in response came from a different identity provider.",
    statusCode: 400,
  },
  principal_ineligible: {
    message: "This account cannot sign in with single sign-on.",
    statusCode: 403,
  },
  provider_access_denied: {
    message: "Your identity provider did not allow this sign-in.",
    statusCode: 403,
  },
  provider_error: {
    message: "Your identity provider could not complete the sign-in.",
    statusCode: 400,
  },
  provider_interaction_required: {
    message:
      "Your identity provider needs you to sign in there first. Start again from the sign-in page.",
    statusCode: 400,
  },
  provider_unavailable: {
    message: "Your identity provider is unavailable. Try again shortly.",
    statusCode: 503,
  },
  reauthentication_required: {
    message:
      "Your identity provider did not ask you to sign in again as required. Start again from the sign-in page.",
    statusCode: 400,
  },
  response_stale: {
    message: "This sign-in response is too old. Start again from your identity provider.",
    statusCode: 400,
  },
  sign_in_contention: {
    message: "Sign-in is busy right now. Wait a moment and try again.",
    statusCode: 503,
  },
  state_mismatch: {
    message:
      "This sign-in response does not match the sign-in you started. Start again from the sign-in page.",
    statusCode: 400,
  },
  transaction_invalid: {
    message: "This sign-in expired or was already used. Start again from the sign-in page.",
    statusCode: 400,
  },
  unsolicited_disabled: {
    message:
      "Your organization does not allow signing in from the identity provider's app list. Start from the sign-in page.",
    statusCode: 403,
  },
};

export function requiredText(body: Record<string, unknown>, name: string) {
  const value = body[name];
  if (typeof value !== "string" || !value) {
    throw new IdentityError("invalid_request", `${name} is required.`, { exposeDescription: true });
  }
  return value;
}

export function optionalText(body: Record<string, unknown>, name: string) {
  const value = body[name];
  return typeof value === "string" && value ? value : undefined;
}

export interface FederationCookies {
  readonly binding: (value: string, maxAge: number) => string;
  readonly bindingCookieName: string;
  /** The SAML start cookie: the IdP returns the browser by a cross-site POST to the ACS. */
  readonly crossSiteBinding: (value: string, maxAge: number) => string;
  readonly session: (token: string) => string;
}

/** The binding cookie ties a sign-in to the browser that started it. */
export function federationCookies(request: {
  readonly secureCookies: boolean;
  readonly sessionCookieName: string;
}): FederationCookies {
  const bindingCookieName = request.secureCookies ? "__Host-dpl_federation" : "dpl_federation";
  return {
    binding: (value, maxAge) =>
      cookie(bindingCookieName, value, { httpOnly: true, maxAge, secure: request.secureCookies }),
    bindingCookieName,
    crossSiteBinding: (value, maxAge) =>
      cookie(
        bindingCookieName,
        value,
        request.secureCookies
          ? { httpOnly: true, maxAge, sameSite: "none", secure: true }
          : { httpOnly: true, maxAge, secure: false },
      ),
    session: (token) =>
      cookie(request.sessionCookieName, token, {
        httpOnly: true,
        maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
        secure: request.secureCookies,
      }),
  };
}

export function callbackPage(outcome: Exclude<FederationCallbackOutcome, { kind: "signed-in" }>) {
  switch (outcome.kind) {
    case "mailbox-confirmation-sent":
      return federationMessageUi({
        message: `We sent a confirmation link to ${outcome.maskedEmail}. Open it in this browser to connect your account, then sign in again.`,
        statusCode: 200,
        title: "Check your email",
      });
    case "provider-response-invalid":
      return federationMessageUi({
        message: `Your identity provider's response could not be verified (${outcome.code}).`,
        statusCode: 502,
        title: "Sign-in failed",
      });
    case "rejected":
      return federationMessageUi({ ...REJECTIONS[outcome.reason], title: "Sign-in failed" });
    default: {
      const unhandled: never = outcome;
      return unhandled;
    }
  }
}

/** A POST-ed IdP answer redirects with 303 so the browser follows it with a GET. */
export function callbackResponse(
  outcome: FederationCallbackOutcome,
  cookies: FederationCookies,
  redirectStatus: 302 | 303,
): RestApiResponse {
  switch (outcome.kind) {
    case "signed-in":
      return {
        ...redirect(outcome.returnTo, redirectStatus),
        multiValueHeaders: {
          "Set-Cookie": [cookies.binding("", 0), cookies.session(outcome.sessionToken)],
        },
      };
    case "mailbox-confirmation-sent":
      return {
        ...callbackPage(outcome),
        multiValueHeaders: {
          "Set-Cookie": [cookies.binding(outcome.bindingToken, outcome.bindingMaxAgeSeconds)],
        },
      };
    default:
      return {
        ...callbackPage(outcome),
        multiValueHeaders: { "Set-Cookie": [cookies.binding("", 0)] },
      };
  }
}
