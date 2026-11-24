import { SAML_CLOCK_SKEW_MS, type SamlIdentityClaims } from "@deployments-ai/identity/saml";
import type { Ulid } from "../ids.ts";
import type { IdentityFederationUnsolicitedSignInRecord } from "../records/identity-federation.ts";
import { isDatabaseWriteConflict } from "../transaction-conditions.ts";
import { linkAnchor } from "./claims.ts";
import { federatedAssertion, type FederationDenial } from "./linking.ts";
import { createWithExpiringClaims } from "./operations.ts";
import { federationRecord } from "./record-builders.ts";
import {
  requestSource,
  sha256,
  type FederatedSignInDependencies,
  type FederatedSignInOutcome,
  type SignInPlan,
  type SignInPlanner,
} from "./sign-in-plan.ts";

/** An IdP-initiated assertion is accepted until its IssueInstant is this old by our clock. */
export const UNSOLICITED_RESPONSE_MAX_AGE_MS = 5 * 60_000 + SAML_CLOCK_SKEW_MS;

/** Outlives every instant that still accepts the assertion, so the claim never lapses first. */
const ASSERTION_CLAIM_LIFETIME_MS = UNSOLICITED_RESPONSE_MAX_AGE_MS + SAML_CLOCK_SKEW_MS + 60_000;

/** Counted from arrival, so an IdP clock that lags cannot eat the user's time to choose Continue. */
const CONFIRMATION_LIFETIME_MS = 5 * 60_000;

export interface RecordUnsolicitedSignInInput {
  readonly assertionId: string;
  readonly claims: SamlIdentityClaims;
  readonly connectionId: Ulid;
  readonly issueInstant: string;
  readonly organizationId: Ulid;
  readonly returnTo: string;
}

export type RecordUnsolicitedSignInOutcome =
  | { readonly kind: "recorded"; readonly token: string }
  | { readonly kind: "replayed" }
  | { readonly kind: "stale" }
  | { readonly kind: "denied"; readonly reason: FederationDenial };

export interface UnsolicitedSignInSummary {
  readonly email: string;
  readonly issuer: string;
  readonly organizationName: string;
  readonly providerDisplayName: string;
}

/**
 * What the browser proved: an explicit confirmation, or a session of the linked principal. Either
 * way it holds a new binding cookie, so a mailbox confirmation is tied to this browser.
 */
export type UnsolicitedConsent =
  | { readonly bindingHash: string; readonly kind: "browser-session"; readonly principalId: Ulid }
  | { readonly bindingHash: string; readonly kind: "confirmed" };

type SignedIn = Extract<FederatedSignInOutcome, { readonly kind: "signed-in" }>;

export type UnsolicitedSignInOutcome =
  | (SignedIn & { readonly returnTo: string })
  | Exclude<FederatedSignInOutcome, SignedIn>
  | { readonly kind: "confirmation-required" }
  | { readonly kind: "invalid" };

export interface CompleteUnsolicitedSignInInput {
  readonly consent: UnsolicitedConsent;
  readonly ipPrefixHash?: string;
  readonly token: string;
  readonly deviceLabel?: string;
  readonly userAgentHash?: string;
}

export interface UnsolicitedSignInStore {
  readonly completeUnsolicitedSignIn: (
    input: CompleteUnsolicitedSignInInput,
  ) => Promise<UnsolicitedSignInOutcome>;
  readonly describeUnsolicitedSignIn: (
    token: string,
  ) => Promise<UnsolicitedSignInSummary | undefined>;
  readonly recordUnsolicitedSignIn: (
    input: RecordUnsolicitedSignInInput,
  ) => Promise<RecordUnsolicitedSignInOutcome>;
}

type PendingUnsolicitedSignIn = IdentityFederationUnsolicitedSignInRecord & {
  readonly data: Extract<
    IdentityFederationUnsolicitedSignInRecord["data"],
    { readonly status: "pending" }
  >;
};

function isPending(
  record: IdentityFederationUnsolicitedSignInRecord,
): record is PendingUnsolicitedSignIn {
  return record.data.status === "pending";
}

function consumedRecord(pending: PendingUnsolicitedSignIn, at: string) {
  const { assertionKey, connectionId, createdAt, expiresAt, id, organizationId, tokenHash } =
    pending.data;
  return federationRecord("identity-federation-unsolicited-sign-in", {
    assertionKey,
    connectionId,
    createdAt,
    expiresAt,
    id,
    organizationId,
    status: "consumed",
    tokenHash,
    updatedAt: at,
    version: pending.data.version + 1,
  });
}

export function makeUnsolicitedSignInStore(
  dependencies: FederatedSignInDependencies,
  planner: SignInPlanner,
): UnsolicitedSignInStore {
  const { reads } = planner;

  async function pendingSignIn(token: string) {
    const record = await reads.unsolicitedSignIn(sha256(token));
    return record &&
      isPending(record) &&
      Date.parse(record.data.createdAt) + CONFIRMATION_LIFETIME_MS > dependencies.now().getTime()
      ? record
      : undefined;
  }

  async function completionPlan(
    input: CompleteUnsolicitedSignInInput,
  ): Promise<SignInPlan<UnsolicitedSignInOutcome>> {
    const pending = await pendingSignIn(input.token);
    if (!pending) return { kind: "settled", outcome: { kind: "invalid" } };
    const { claims, connectionId, organizationId, returnTo } = pending.data;
    const resolution = await planner.resolve({
      assertion: { ...claims, protocol: "saml" },
      connectionId,
      organizationId,
    });
    if (resolution.kind === "denied") return { kind: "settled", outcome: resolution };
    const { facts } = resolution;
    if (
      facts.provider.data.protocol !== "saml" ||
      facts.provider.data.unsolicitedSignIn !== "enabled"
    ) {
      return { kind: "settled", outcome: { kind: "denied", reason: "connection_inactive" } };
    }
    // A sign-in decision pins this link record, so the principal cannot change before the write.
    if (
      input.consent.kind === "browser-session" &&
      facts.linkRecord?.data.principalId !== input.consent.principalId
    ) {
      return { kind: "settled", outcome: { kind: "confirmation-required" } };
    }
    const plan = await planner.plan({
      bindingHash: input.consent.bindingHash,
      consume: [
        {
          kind: "put",
          previousRecord: pending,
          record: consumedRecord(pending, dependencies.now().toISOString()),
        },
      ],
      facts,
      ...requestSource(input),
    });
    const outcome: UnsolicitedSignInOutcome =
      plan.outcome.kind === "signed-in" ? { ...plan.outcome, returnTo } : plan.outcome;
    return { ...plan, outcome };
  }

  return {
    async recordUnsolicitedSignIn(input) {
      const observedAt = dependencies.now();
      const issuedAt = Date.parse(input.issueInstant);
      if (observedAt.getTime() - issuedAt > UNSOLICITED_RESPONSE_MAX_AGE_MS) {
        return { kind: "stale" };
      }
      const asserted = federatedAssertion(input.claims);
      if (asserted.kind === "denied") return asserted;
      const { displayName, email, emailDomain, issuer, subject } = asserted.assertion;
      const createdAt = observedAt.toISOString();
      const token = dependencies.newToken();
      const record = federationRecord("identity-federation-unsolicited-sign-in", {
        assertionKey: sha256(`${issuer}\u0000${input.assertionId}`),
        claims: { ...(displayName ? { displayName } : {}), email, emailDomain, issuer, subject },
        connectionId: input.connectionId,
        createdAt,
        // The record carries the replay claim's TTL and must also outlive its confirmation.
        expiresAt: new Date(
          Math.max(
            issuedAt + ASSERTION_CLAIM_LIFETIME_MS,
            observedAt.getTime() + CONFIRMATION_LIFETIME_MS,
          ),
        ).toISOString(),
        id: dependencies.generateId(),
        organizationId: input.organizationId,
        returnTo: input.returnTo,
        status: "pending",
        tokenHash: sha256(token),
        updatedAt: createdAt,
        version: 1,
      });
      try {
        await dependencies.database.transactWrite(createWithExpiringClaims(record, createdAt));
      } catch (error) {
        if (isDatabaseWriteConflict(error)) return { kind: "replayed" };
        throw error;
      }
      return { kind: "recorded", token };
    },

    async describeUnsolicitedSignIn(token) {
      const pending = await pendingSignIn(token);
      if (!pending) return undefined;
      const { claims, connectionId, organizationId } = pending.data;
      const [provider, organization] = await Promise.all([
        reads.provider(organizationId),
        reads.organization(organizationId),
      ]);
      if (
        provider?.data.state.kind !== "active" ||
        provider.data.connectionId !== connectionId ||
        !organization
      ) {
        return undefined;
      }
      const link = await reads.link(linkAnchor(provider.data), claims.subject);
      const linked = link ? await reads.principal(link.data.principalId) : undefined;
      return {
        email: linked?.data.primaryEmail ?? claims.email,
        issuer: claims.issuer,
        organizationName: organization.data.name,
        providerDisplayName: provider.data.displayName,
      };
    },

    completeUnsolicitedSignIn: (input) => planner.commit(() => completionPlan(input)),
  };
}
