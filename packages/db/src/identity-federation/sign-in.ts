import type { Ulid } from "../ids.ts";
import {
  identityProviderProtocol,
  type IdentityFederationTransactionRecord,
  type IdentityProviderProtocol,
  type OrganizationIdentityProviderRecord,
} from "../records/identity-federation.ts";
import type { OrganizationRole } from "../tenancy-contracts.ts";
import { isDatabaseWriteConflict } from "../transaction-conditions.ts";
import {
  federatedAssertion,
  normalizedEmailDomain,
  type FederatedIdentityClaims,
} from "./linking.ts";
import {
  makeLinkConfirmation,
  pendingFederationLink,
  type LinkConfirmationInput,
  type LinkConfirmationOutcome,
  type PendingFederationLink,
} from "./link-confirmation.ts";
import { federationRecord, nextFederationRecord } from "./record-builders.ts";
import {
  makeSignInPlanner,
  plusSeconds,
  requestSource,
  type FederatedSignInConfig,
  type FederatedSignInDependencies,
  type FederatedSignInOutcome,
} from "./sign-in-plan.ts";
import { makeUnsolicitedSignInStore, type UnsolicitedSignInStore } from "./unsolicited-sign-in.ts";

export interface FederationDiscovery {
  readonly displayName: string;
  readonly issuer: string;
  readonly organizationId: Ulid;
  readonly protocol: IdentityProviderProtocol;
}

export interface BeginFederationTransactionInput {
  readonly connectionId: Ulid;
  readonly forceLogin: boolean;
  readonly lookupHash: string;
  readonly organizationId: Ulid;
  readonly returnTo: string;
}

/** Only `consumeTransaction` returns one, so a solicited sign-in completes at most once. */
export type ConsumedFederationTransaction = IdentityFederationTransactionRecord & {
  readonly data: { readonly status: "consumed" };
};

export interface CompleteFederatedSignInInput {
  readonly claims: FederatedIdentityClaims;
  readonly ipPrefixHash?: string;
  readonly transaction: ConsumedFederationTransaction;
  readonly deviceLabel?: string;
  readonly userAgentHash?: string;
}

export interface FederatedSignInStore extends UnsolicitedSignInStore {
  readonly activeMemberRole: (
    organizationId: Ulid,
    principalId: Ulid,
  ) => Promise<OrganizationRole | undefined>;
  readonly activeProvider: (
    organizationId: Ulid,
  ) => Promise<OrganizationIdentityProviderRecord | undefined>;
  readonly beginTransaction: (
    input: BeginFederationTransactionInput,
  ) => Promise<IdentityFederationTransactionRecord>;
  readonly completeSignIn: (input: CompleteFederatedSignInInput) => Promise<FederatedSignInOutcome>;
  readonly confirmLink: (input: LinkConfirmationInput) => Promise<LinkConfirmationOutcome>;
  readonly consumeTransaction: (input: {
    readonly lookupHash: string;
    readonly organizationId: Ulid;
  }) => Promise<ConsumedFederationTransaction | undefined>;
  readonly discover: (email: string) => Promise<FederationDiscovery | undefined>;
  readonly pendingLink: (token: string) => Promise<PendingFederationLink | undefined>;
}

function isConsumed(
  transaction: IdentityFederationTransactionRecord,
): transaction is ConsumedFederationTransaction {
  return transaction.data.status === "consumed";
}

export function makeFederatedSignInStore(
  dependencies: FederatedSignInDependencies,
  config: FederatedSignInConfig,
): FederatedSignInStore {
  const planner = makeSignInPlanner(dependencies, config);
  const { activeProvider, reads } = planner;

  return {
    ...makeUnsolicitedSignInStore(dependencies, planner),

    async discover(email) {
      const domain = normalizedEmailDomain(email);
      const owner = domain ? await reads.verifiedDomainOwner(domain) : undefined;
      if (owner?.data.state.kind !== "verified") return undefined;
      const provider = await activeProvider(owner.data.organizationId);
      if (!provider) return undefined;
      return {
        displayName: provider.data.displayName,
        issuer: provider.data.issuer,
        organizationId: provider.data.organizationId,
        protocol: identityProviderProtocol(provider.data),
      };
    },

    async activeMemberRole(organizationId, principalId) {
      const member = await reads.member(organizationId, principalId);
      return member?.data.status === "active" ? member.data.role : undefined;
    },

    activeProvider,

    confirmLink: makeLinkConfirmation(dependencies),

    pendingLink: (token) => pendingFederationLink(dependencies.database, token, dependencies.now()),

    async beginTransaction(input) {
      const at = dependencies.now();
      const createdAt = at.toISOString();
      const transaction = federationRecord("identity-federation-transaction", {
        ...input,
        createdAt,
        expiresAt: plusSeconds(at, config.transactionLifetimeSeconds),
        id: dependencies.generateId(),
        status: "pending",
        updatedAt: createdAt,
        version: 1,
      });
      await dependencies.database.transactWrite([{ kind: "put", record: transaction }]);
      return transaction;
    },

    async consumeTransaction(input) {
      const transaction = await reads.transaction(input.lookupHash);
      const at = dependencies.now();
      if (
        transaction?.data.status !== "pending" ||
        transaction.data.organizationId !== input.organizationId ||
        Date.parse(transaction.data.expiresAt) <= at.getTime()
      ) {
        return undefined;
      }
      const consumed = nextFederationRecord(transaction, { status: "consumed" }, at.toISOString());
      try {
        await dependencies.database.transactWrite([
          { kind: "put", previousRecord: transaction, record: consumed },
        ]);
      } catch (error) {
        if (isDatabaseWriteConflict(error)) return undefined;
        throw error;
      }
      return isConsumed(consumed) ? consumed : undefined;
    },

    async completeSignIn(input) {
      const asserted = federatedAssertion(input.claims);
      if (asserted.kind === "denied") return asserted;
      const { transaction } = input;
      return planner.commit(async () => {
        const resolution = await planner.resolve({
          assertion: asserted.assertion,
          connectionId: transaction.data.connectionId,
          organizationId: transaction.data.organizationId,
        });
        if (resolution.kind === "denied") return { kind: "settled", outcome: resolution };
        return planner.plan({
          bindingHash: transaction.data.lookupHash,
          consume: [],
          facts: resolution.facts,
          ...requestSource(input),
        });
      });
    },
  };
}
