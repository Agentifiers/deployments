import type { FederatedSignInOutcome, FederationDenial } from "@deployments-ai/db";
import type { FederationErrorCode } from "@deployments-ai/identity";
import type { SamlIdentityClaimsDefect, SamlResponseDefect } from "@deployments-ai/identity/saml";

export type IdentityProviderErrorReason =
  | "provider_access_denied"
  | "provider_error"
  | "provider_interaction_required"
  | "provider_unavailable";

/** Why an IdP's answer, OIDC callback or SAML ACS post, did not sign the browser in. */
export type FederationCallbackRejection =
  | "assertion_replayed"
  | "binding_missing"
  | "connection_changed"
  | "issuer_mismatch"
  | "reauthentication_required"
  | "response_stale"
  | "sign_in_contention"
  | "state_mismatch"
  | "transaction_invalid"
  | "unsolicited_disabled"
  | FederationDenial
  | IdentityProviderErrorReason;

export type ProviderResponseDefect =
  | FederationErrorCode
  | SamlIdentityClaimsDefect
  | SamlResponseDefect;

export type FederationCallbackOutcome =
  | { readonly kind: "signed-in"; readonly returnTo: string; readonly sessionToken: string }
  | {
      readonly kind: "mailbox-confirmation-sent";
      readonly bindingMaxAgeSeconds: number;
      readonly bindingToken: string;
      readonly maskedEmail: string;
    }
  | { readonly kind: "rejected"; readonly reason: FederationCallbackRejection }
  | { readonly kind: "provider-response-invalid"; readonly code: ProviderResponseDefect };

/** The mailbox confirmation is bound to `bindingToken`, so the browser keeps it until expiry. */
export function mailboxOutcome(
  outcome: Extract<FederatedSignInOutcome, { readonly kind: "mailbox-confirmation-sent" }>,
  bindingToken: string,
  now: Date,
): Extract<FederationCallbackOutcome, { readonly kind: "mailbox-confirmation-sent" }> {
  return {
    bindingMaxAgeSeconds: Math.round((Date.parse(outcome.expiresAt) - now.getTime()) / 1_000),
    bindingToken,
    kind: "mailbox-confirmation-sent",
    maskedEmail: outcome.maskedEmail,
  };
}

export function completionOutcome(
  outcome: FederatedSignInOutcome,
  input: { readonly bindingToken: string; readonly now: Date; readonly returnTo: string },
): FederationCallbackOutcome {
  switch (outcome.kind) {
    case "signed-in":
      return { kind: "signed-in", returnTo: input.returnTo, sessionToken: outcome.sessionToken };
    case "mailbox-confirmation-sent":
      return mailboxOutcome(outcome, input.bindingToken, input.now);
    case "denied":
      return { kind: "rejected", reason: outcome.reason };
    default: {
      const unhandled: never = outcome;
      return unhandled;
    }
  }
}
