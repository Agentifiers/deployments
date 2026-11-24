import {
  FederatedSignInContentionError,
  Ulid,
  exemptFromSsoEnforcement,
  federatedSessionSatisfies,
  identityProviderProtocol,
  identityProviderSecretBinding,
  requestSource,
  type FederatedSignInStore,
  type IdentityProviderProtocol,
  type FederationDiscovery,
  type ConsumedFederationTransaction,
  type IdentitySessionAuthentication,
  type OidcIdentityProvider,
  type OrganizationIdentityProviderRecord,
  type PendingFederationLink,
} from "@deployments-ai/db";
import {
  FederationError,
  constantTimeTextEqual,
  federationAuthorizationUrl,
  federationBinding,
  randomToken,
  redeemFederationCode,
  type FederationBinding,
  type FederationHttp,
  type FederationJwksCache,
} from "@deployments-ai/identity";
import { Schema } from "effect";
import {
  REAUTHENTICATION_TOKEN_PARAMETER,
  type AuthorizeContinuation,
} from "./authorize-continuation.ts";
import {
  completionOutcome,
  type FederationCallbackOutcome,
  type FederationCallbackRejection,
  type IdentityProviderErrorReason,
} from "./federation-completion.ts";
import {
  makeSamlApplication,
  samlAuthnLocation,
  type SamlApplication,
} from "./saml-application.ts";

const isUlid = Schema.is(Ulid);

export interface FederationApplicationDependencies {
  readonly decryptEnvelope: (
    envelope: OidcIdentityProvider["clientSecret"],
    binding: Readonly<Record<string, string>>,
  ) => Promise<unknown>;
  readonly http: FederationHttp;
  readonly jwks: FederationJwksCache;
  readonly now: () => Date;
  readonly store: FederatedSignInStore;
}

export interface FederationApplicationConfig {
  readonly applicationOrigin: string;
  readonly issuer: string;
}

export type FederationDiscoveryResult =
  | { readonly kind: "password" }
  | ({ readonly kind: "sso" } & FederationDiscovery);

export type OrganizationHintRoute =
  | { readonly kind: "ignored" }
  | { readonly kind: "satisfied"; readonly organizationId: Ulid }
  | { readonly kind: "sign-in"; readonly organizationId: Ulid };

export interface FederationStart {
  readonly bindingMaxAgeSeconds: number;
  readonly bindingToken: string;
  readonly location: string;
  readonly protocol: IdentityProviderProtocol;
}

export type FederationLinkConfirmation =
  | { readonly kind: "linked"; readonly provider?: FederationDiscovery }
  | { readonly kind: "browser-mismatch" }
  | { readonly kind: "invalid" };

export type FederationLinkRequest = Pick<
  PendingFederationLink,
  "identityProvider" | "organizationName"
>;

export interface FederationCallbackInput {
  readonly bindingToken: string | undefined;
  readonly ipPrefixHash?: string;
  readonly organizationId: string;
  readonly query: Readonly<Record<string, string | undefined>>;
  readonly deviceLabel?: string;
  readonly userAgentHash?: string;
}

export interface FederationApplication extends SamlApplication {
  readonly callback: (input: FederationCallbackInput) => Promise<FederationCallbackOutcome>;
  readonly confirmLink: (input: {
    readonly bindingToken: string | undefined;
    readonly token: string;
  }) => Promise<FederationLinkConfirmation>;
  readonly discover: (email: string) => Promise<FederationDiscoveryResult>;
  readonly organization: (
    organizationId: string | undefined,
  ) => Promise<FederationDiscovery | undefined>;
  readonly organizationHint: (input: {
    readonly browser:
      | { readonly authentication: IdentitySessionAuthentication; readonly principalId: Ulid }
      | undefined;
    readonly hint: string | undefined;
  }) => Promise<OrganizationHintRoute>;
  readonly pendingLink: (token: string) => Promise<FederationLinkRequest | undefined>;
  readonly start: (input: {
    readonly loginHint?: string;
    readonly organizationId: string;
    readonly returnTo: AuthorizeContinuation | undefined;
  }) => Promise<FederationStart | undefined>;
}

const PROVIDER_ERRORS: Readonly<Record<string, IdentityProviderErrorReason>> = {
  access_denied: "provider_access_denied",
  consent_required: "provider_interaction_required",
  interaction_required: "provider_interaction_required",
  login_required: "provider_interaction_required",
  server_error: "provider_unavailable",
  temporarily_unavailable: "provider_unavailable",
};

function discovery(provider: OrganizationIdentityProviderRecord): FederationDiscovery | undefined {
  const { displayName, issuer, organizationId, state } = provider.data;
  return state.kind === "active"
    ? { displayName, issuer, organizationId, protocol: identityProviderProtocol(provider.data) }
    : undefined;
}

function continuationForcesLogin(returnTo: string) {
  const continuation = new URL(returnTo, "https://identity.invalid").searchParams;
  return (
    continuation.has(REAUTHENTICATION_TOKEN_PARAMETER) ||
    (continuation.get("prompt") ?? "").split(" ").includes("login") ||
    continuation.get("max_age") === "0"
  );
}

export function makeFederationApplication(
  dependencies: FederationApplicationDependencies,
  config: FederationApplicationConfig,
): FederationApplication {
  const { now, store } = dependencies;
  // The authorization request and the code exchange must send byte-identical redirect URIs.
  const callbackUrl = (organizationId: Ulid) =>
    `${config.issuer}/oauth2/federation/callback/${organizationId}`;
  const rejected = (reason: FederationCallbackRejection): FederationCallbackOutcome => ({
    kind: "rejected",
    reason,
  });

  async function organization(organizationId: string | undefined) {
    const provider = isUlid(organizationId)
      ? await store.activeProvider(organizationId)
      : undefined;
    return provider && discovery(provider);
  }

  async function clientSecret(provider: OidcIdentityProvider) {
    const secret = await dependencies.decryptEnvelope(
      provider.clientSecret,
      identityProviderSecretBinding(provider),
    );
    if (typeof secret !== "string" || !secret) {
      throw new Error("The identity provider client secret envelope does not hold a secret.");
    }
    return secret;
  }

  async function signIn(input: {
    readonly binding: FederationBinding;
    readonly bindingToken: string;
    readonly code: string;
    readonly ipPrefixHash?: string;
    readonly provider: OidcIdentityProvider;
    readonly transaction: ConsumedFederationTransaction;
    readonly deviceLabel?: string;
    readonly userAgentHash?: string;
  }): Promise<FederationCallbackOutcome> {
    const { binding, provider, transaction } = input;
    const connection = {
      clientId: provider.clientId,
      clientSecret: await clientSecret(provider),
      endpoints: provider.endpoints,
      issuer: provider.issuer,
      redirectUri: callbackUrl(transaction.data.organizationId),
      signingAlgorithms: provider.signingAlgorithms,
      tokenEndpointAuthMethod: provider.tokenEndpointAuthMethod,
    };
    const claims = await redeemFederationCode({
      binding,
      code: input.code,
      connection,
      http: dependencies.http,
      jwks: dependencies.jwks,
      now: now(),
      ...(transaction.data.forceLogin
        ? { forceLoginSince: new Date(transaction.data.createdAt) }
        : {}),
    });
    const outcome = await store.completeSignIn({
      claims,
      ...requestSource(input),
      transaction,
    });
    return completionOutcome(outcome, {
      bindingToken: input.bindingToken,
      now: now(),
      returnTo: transaction.data.returnTo,
    });
  }

  return {
    ...makeSamlApplication({ now, store }, config),

    async callback(input) {
      const { query } = input;
      if (!input.bindingToken) return rejected("binding_missing");
      const binding = federationBinding(input.bindingToken);
      if (!query.state || !constantTimeTextEqual(query.state, binding.state)) {
        return rejected("state_mismatch");
      }
      const transaction = isUlid(input.organizationId)
        ? await store.consumeTransaction({
            lookupHash: binding.lookupHash,
            organizationId: input.organizationId,
          })
        : undefined;
      if (!transaction) return rejected("transaction_invalid");
      if (query.error !== undefined) {
        const reason = Object.hasOwn(PROVIDER_ERRORS, query.error)
          ? PROVIDER_ERRORS[query.error]
          : undefined;
        return rejected(reason ?? "provider_error");
      }
      const provider = await store.activeProvider(transaction.data.organizationId);
      if (!provider || provider.data.connectionId !== transaction.data.connectionId) {
        return rejected("connection_changed");
      }
      if (provider.data.protocol === "saml") return rejected("connection_inactive");
      if (query.iss !== undefined && query.iss !== provider.data.issuer) {
        return rejected("issuer_mismatch");
      }
      if (!query.code) return rejected("provider_error");
      try {
        return await signIn({
          binding,
          bindingToken: input.bindingToken,
          code: query.code,
          ...requestSource(input),
          provider: provider.data,
          transaction,
        });
      } catch (error) {
        if (error instanceof FederationError) {
          return { code: error.code, kind: "provider-response-invalid" };
        }
        if (error instanceof FederatedSignInContentionError) return rejected("sign_in_contention");
        throw error;
      }
    },

    async confirmLink(input) {
      const outcome = await store.confirmLink({
        bindingHash: input.bindingToken && federationBinding(input.bindingToken).lookupHash,
        token: input.token,
      });
      if (outcome.kind !== "linked") return outcome;
      const provider = await organization(outcome.organizationId);
      return { kind: "linked", ...(provider ? { provider } : {}) };
    },

    async discover(email) {
      const found = await store.discover(email);
      return found ? { kind: "sso", ...found } : { kind: "password" };
    },

    organization,

    async pendingLink(token) {
      const link = await store.pendingLink(token);
      return (
        link && { identityProvider: link.identityProvider, organizationName: link.organizationName }
      );
    },

    async organizationHint(input) {
      const provider = isUlid(input.hint) ? await store.activeProvider(input.hint) : undefined;
      if (provider?.data.state.kind !== "active") return { kind: "ignored" };
      const { organizationId } = provider.data;
      const { browser } = input;
      const satisfied =
        browser !== undefined &&
        (provider.data.state.enforcement === "optional" ||
          federatedSessionSatisfies({
            authentication: browser.authentication,
            now: now(),
            provider: provider.data,
          }) ||
          exemptFromSsoEnforcement(
            await store.activeMemberRole(organizationId, browser.principalId),
          ));
      return { kind: satisfied ? "satisfied" : "sign-in", organizationId };
    },

    async start(input) {
      const provider = isUlid(input.organizationId)
        ? await store.activeProvider(input.organizationId)
        : undefined;
      if (!provider) return undefined;
      const returnTo = input.returnTo ?? config.applicationOrigin;
      const forceLogin = continuationForcesLogin(returnTo);
      const bindingToken = randomToken();
      const binding = federationBinding(bindingToken);
      const transaction = await store.beginTransaction({
        connectionId: provider.data.connectionId,
        forceLogin,
        lookupHash: binding.lookupHash,
        organizationId: provider.data.organizationId,
        returnTo,
      });
      const location =
        provider.data.protocol === "saml"
          ? samlAuthnLocation({
              binding,
              forceLogin,
              issuer: config.issuer,
              now: now(),
              provider: provider.data,
              relayState: transaction.data.id,
            })
          : federationAuthorizationUrl({
              binding,
              connection: {
                clientId: provider.data.clientId,
                endpoints: provider.data.endpoints,
                redirectUri: callbackUrl(provider.data.organizationId),
              },
              forceLogin,
              ...(input.loginHint ? { loginHint: input.loginHint } : {}),
            });
      return {
        bindingMaxAgeSeconds: Math.round(
          (Date.parse(transaction.data.expiresAt) - Date.parse(transaction.data.createdAt)) / 1_000,
        ),
        bindingToken,
        location,
        protocol: identityProviderProtocol(provider.data),
      };
    },
  };
}
