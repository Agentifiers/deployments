import {
  FederatedSignInContentionError,
  Ulid,
  requestSource,
  type ConsumedFederationTransaction,
  type FederatedSignInStore,
  type SamlIdentityProvider,
  type UnsolicitedSignInOutcome,
  type UnsolicitedSignInSummary,
} from "@deployments-ai/db";
import {
  constantTimeTextEqual,
  federationBinding,
  randomToken,
  type FederationBinding,
} from "@deployments-ai/identity";
import {
  SAML_CLOCK_SKEW_MS,
  samlAuthnRedirectUrl,
  samlIdentityClaims,
  samlServiceProvider,
  serviceProviderMetadataXml,
  verifySamlResponse,
  type SamlIdentityClaims,
  type SamlTrust,
  type VerifiedAssertion,
} from "@deployments-ai/identity/saml";
import { Schema } from "effect";
import { safeReturnTo } from "./authorize-continuation.ts";
import {
  completionOutcome,
  mailboxOutcome,
  type FederationCallbackOutcome,
  type FederationCallbackRejection,
} from "./federation-completion.ts";

/** Bounds the ACS form as API Gateway delivers it; signed SAML responses run to tens of KiB. */
export const SAML_RESPONSE_BYTE_LIMIT = 128 * 1_024;

const isUlid = Schema.is(Ulid);

type FederationRefusal = Extract<
  FederationCallbackOutcome,
  { readonly kind: "provider-response-invalid" | "rejected" }
>;

/**
 * Only a post that spent the browser's solicited transaction is `consumed` and retires its binding
 * cookie. Anyone can make a browser POST to the ACS, so a `refused` post leaves the binding alone.
 */
export type SamlAcsOutcome =
  | { readonly kind: "consumed"; readonly outcome: FederationCallbackOutcome }
  | { readonly kind: "refused"; readonly refusal: FederationRefusal }
  | { readonly kind: "confirmation-required"; readonly token: string };

/** Where an IdP-initiated sign-in stands once the browser has opened its confirmation page. */
export type UnsolicitedSignInStep =
  | Exclude<FederationCallbackOutcome, { readonly kind: "provider-response-invalid" }>
  | { readonly kind: "confirmation-required"; readonly summary: UnsolicitedSignInSummary }
  | { readonly kind: "invalid" };

interface RequestSource {
  readonly ipPrefixHash?: string;
  readonly deviceLabel?: string;
  readonly userAgentHash?: string;
}

export interface SamlAcsInput extends RequestSource {
  readonly bindingToken: string | undefined;
  readonly form: Readonly<Record<string, string>>;
  readonly organizationId: string;
}

export interface SamlApplication {
  /** The IdP's HTTP-POST to `/saml/:org/acs`, solicited or not. */
  readonly acs: (input: SamlAcsInput) => Promise<SamlAcsOutcome>;
  /** The user chose Continue on the confirmation page, in the browser `bindingToken` now marks. */
  readonly confirmUnsolicitedSignIn: (
    input: RequestSource & { readonly token: string },
  ) => Promise<UnsolicitedSignInStep>;
  /** The confirmation page opened; a session of the linked principal completes it silently. */
  readonly resumeUnsolicitedSignIn: (
    input: RequestSource & {
      readonly browserPrincipalId: Ulid | undefined;
      readonly token: string;
    },
  ) => Promise<UnsolicitedSignInStep>;
  readonly serviceProviderMetadata: (organizationId: string) => string | undefined;
}

export interface SamlApplicationConfig {
  readonly applicationOrigin: string;
  readonly issuer: string;
}

/** The HTTP-Redirect AuthnRequest whose ID only the browser holding `binding`'s token can match. */
export function samlAuthnLocation(input: {
  readonly binding: FederationBinding;
  readonly forceLogin: boolean;
  readonly issuer: string;
  readonly now: Date;
  readonly provider: SamlIdentityProvider;
  readonly relayState: string;
}) {
  const serviceProvider = samlServiceProvider({
    issuer: input.issuer,
    organizationId: input.provider.organizationId,
  });
  return samlAuthnRedirectUrl({
    acsUrl: serviceProvider.acsUrl,
    forceAuthn: input.forceLogin,
    now: input.now,
    relayState: input.relayState,
    requestId: input.binding.samlRequestId,
    singleSignOnUrl: input.provider.singleSignOnUrl,
    spEntityId: serviceProvider.entityId,
  });
}

function trustFor(provider: SamlIdentityProvider, issuer: string): SamlTrust {
  const serviceProvider = samlServiceProvider({ issuer, organizationId: provider.organizationId });
  const [first, ...rest] = provider.signingCertificates;
  return {
    acsUrl: serviceProvider.acsUrl,
    idpEntityId: provider.issuer,
    signingCertificates: [first.certificate, ...rest.map(({ certificate }) => certificate)],
    spEntityId: serviceProvider.entityId,
  };
}

export function makeSamlApplication(
  dependencies: { readonly now: () => Date; readonly store: FederatedSignInStore },
  config: SamlApplicationConfig,
): SamlApplication {
  const { now, store } = dependencies;
  const rejected = (reason: FederationCallbackRejection) => ({ kind: "rejected", reason }) as const;
  const refused = (refusal: FederationRefusal) => ({ kind: "refused", refusal }) as const;

  async function settle(input: {
    readonly assertion: VerifiedAssertion;
    readonly bindingToken: string;
    readonly claims: SamlIdentityClaims;
    readonly hashes: RequestSource;
    readonly provider: SamlIdentityProvider;
    readonly transaction: ConsumedFederationTransaction;
  }): Promise<FederationCallbackOutcome> {
    const { transaction } = input;
    if (transaction.data.connectionId !== input.provider.connectionId) {
      return rejected("connection_changed");
    }
    if (
      transaction.data.forceLogin &&
      Date.parse(input.assertion.authnInstant) <
        Date.parse(transaction.data.createdAt) - SAML_CLOCK_SKEW_MS
    ) {
      return rejected("reauthentication_required");
    }
    try {
      const outcome = await store.completeSignIn({
        claims: input.claims,
        transaction,
        ...requestSource(input.hashes),
      });
      return completionOutcome(outcome, {
        bindingToken: input.bindingToken,
        now: now(),
        returnTo: transaction.data.returnTo,
      });
    } catch (error) {
      if (error instanceof FederatedSignInContentionError) return rejected("sign_in_contention");
      throw error;
    }
  }

  async function solicited(input: {
    readonly assertion: VerifiedAssertion;
    readonly bindingToken: string | undefined;
    readonly claims: SamlIdentityClaims;
    readonly hashes: RequestSource;
    readonly inResponseTo: string;
    readonly provider: SamlIdentityProvider;
  }): Promise<SamlAcsOutcome> {
    const { bindingToken } = input;
    if (!bindingToken) return refused(rejected("binding_missing"));
    const binding = federationBinding(bindingToken);
    if (!constantTimeTextEqual(input.inResponseTo, binding.samlRequestId)) {
      return refused(rejected("state_mismatch"));
    }
    const transaction = await store.consumeTransaction({
      lookupHash: binding.lookupHash,
      organizationId: input.provider.organizationId,
    });
    if (!transaction) return refused(rejected("transaction_invalid"));
    return { kind: "consumed", outcome: await settle({ ...input, bindingToken, transaction }) };
  }

  async function unsolicited(input: {
    readonly assertion: VerifiedAssertion;
    readonly claims: SamlIdentityClaims;
    readonly provider: SamlIdentityProvider;
    readonly relayState: string | undefined;
  }): Promise<SamlAcsOutcome> {
    if (input.provider.unsolicitedSignIn !== "enabled") {
      return refused(rejected("unsolicited_disabled"));
    }
    const recorded = await store.recordUnsolicitedSignIn({
      assertionId: input.assertion.assertionId,
      claims: input.claims,
      connectionId: input.provider.connectionId,
      issueInstant: input.assertion.issueInstant,
      organizationId: input.provider.organizationId,
      returnTo: safeReturnTo(input.relayState) ?? config.applicationOrigin,
    });
    switch (recorded.kind) {
      case "recorded":
        return { kind: "confirmation-required", token: recorded.token };
      case "replayed":
        return refused(rejected("assertion_replayed"));
      case "stale":
        return refused(rejected("response_stale"));
      case "denied":
        return refused(rejected(recorded.reason));
      default: {
        const unhandled: never = recorded;
        return unhandled;
      }
    }
  }

  async function step(
    outcome: UnsolicitedSignInOutcome,
    token: string,
    bindingToken: string,
  ): Promise<UnsolicitedSignInStep> {
    switch (outcome.kind) {
      case "signed-in":
        return {
          kind: "signed-in",
          returnTo: outcome.returnTo,
          sessionToken: outcome.sessionToken,
        };
      case "mailbox-confirmation-sent":
        return mailboxOutcome(outcome, bindingToken, now());
      case "denied":
        return rejected(outcome.reason);
      case "confirmation-required": {
        const summary = await store.describeUnsolicitedSignIn(token);
        return summary ? { kind: "confirmation-required", summary } : { kind: "invalid" };
      }
      case "invalid":
        return outcome;
      default: {
        const unhandled: never = outcome;
        return unhandled;
      }
    }
  }

  return {
    async acs(input) {
      const provider = isUlid(input.organizationId)
        ? await store.activeProvider(input.organizationId)
        : undefined;
      if (provider?.data.protocol !== "saml") return refused(rejected("connection_inactive"));
      const xml = Buffer.from(input.form.SAMLResponse ?? "", "base64").toString("utf8");
      const verified = verifySamlResponse(xml, trustFor(provider.data, config.issuer), now());
      if (verified.kind === "rejected") {
        return refused({ code: verified.defect, kind: "provider-response-invalid" });
      }
      const { assertion } = verified;
      const derived = samlIdentityClaims(assertion, provider.data.emailAttribute);
      if (derived.kind === "rejected") {
        return refused({ code: derived.defect, kind: "provider-response-invalid" });
      }
      // The verifier ties a Response InResponseTo to the signed one, so only a response that
      // names no request anywhere is IdP-initiated.
      return assertion.inResponseTo === null
        ? unsolicited({
            assertion,
            claims: derived.claims,
            provider: provider.data,
            relayState: input.form.RelayState,
          })
        : solicited({
            assertion,
            bindingToken: input.bindingToken,
            claims: derived.claims,
            hashes: input,
            inResponseTo: assertion.inResponseTo,
            provider: provider.data,
          });
    },

    async resumeUnsolicitedSignIn(input) {
      if (input.browserPrincipalId === undefined) {
        const summary = await store.describeUnsolicitedSignIn(input.token);
        return summary ? { kind: "confirmation-required", summary } : { kind: "invalid" };
      }
      const bindingToken = randomToken();
      const outcome = await store.completeUnsolicitedSignIn({
        consent: {
          bindingHash: federationBinding(bindingToken).lookupHash,
          kind: "browser-session",
          principalId: input.browserPrincipalId,
        },
        token: input.token,
        ...requestSource(input),
      });
      return step(outcome, input.token, bindingToken);
    },

    async confirmUnsolicitedSignIn(input) {
      const bindingToken = randomToken();
      const outcome = await store.completeUnsolicitedSignIn({
        consent: { bindingHash: federationBinding(bindingToken).lookupHash, kind: "confirmed" },
        token: input.token,
        ...requestSource(input),
      });
      return step(outcome, input.token, bindingToken);
    },

    serviceProviderMetadata: (organizationId) =>
      isUlid(organizationId)
        ? serviceProviderMetadataXml(samlServiceProvider({ issuer: config.issuer, organizationId }))
        : undefined,
  };
}
