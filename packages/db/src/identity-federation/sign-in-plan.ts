import { createHash } from "node:crypto";
import type {
  DynamoDatabaseService,
  SemanticEventRecord,
  TransactionOperation,
} from "../client-types.ts";
import { makeDirectoryReads } from "../directory/reads.ts";
import type { Ulid } from "../ids.ts";
import { newHumanPrincipalOperations } from "../identity/principal-creation.ts";
import {
  identityEmailDeliveryBinding,
  identityEmailDeliveryShard,
  pendingEmailDeliveryRecord,
  sessionRecords,
  type ProtectedEnvelope,
} from "../identity/record-builders.ts";
import { makeIdentitySecurityEventRecord } from "../identity/security-events.ts";
import { memberActivation } from "../organization-membership-changes.ts";
import type { PrincipalIdentityRecord, PrincipalRecord } from "../records/identity.ts";
import {
  identityProviderProtocol,
  type FederatedAuthentication,
  type OrganizationIdentityProviderRecord,
  type OrganizationLoginDomainRecord,
} from "../records/identity-federation.ts";
import { makeSemanticEventRecord, transactWithSemanticEvents } from "../semantic-event-storage.ts";
import { isDatabaseWriteConflict } from "../transaction-conditions.ts";
import { linkAnchor } from "./claims.ts";
import {
  directLinkConditions,
  provisionedStanding,
  type DirectLinkEvidence,
} from "./direct-link.ts";
import {
  decidePrincipal,
  jitMembership,
  normalizedEmailDomain,
  type FederatedAssertion,
  type FederationDenial,
  type PrincipalDecision,
} from "./linking.ts";
import { createWithClaims, endPrincipalSessions, maskedEmail, versionPin } from "./operations.ts";
import { makeFederationReads, type FederationReads } from "./reads.ts";
import { federationRecord } from "./record-builders.ts";

const SIGN_IN_WRITE_ATTEMPTS = 5;

export interface FederatedSignInDependencies {
  readonly database: DynamoDatabaseService;
  readonly encryptEmailPayload: (
    value: unknown,
    binding: Readonly<Record<string, string>>,
  ) => Promise<ProtectedEnvelope>;
  readonly generateId: () => Ulid;
  readonly newToken: () => string;
  readonly now: () => Date;
}

export interface FederatedSignInConfig {
  readonly linkRequestLifetimeSeconds: number;
  readonly sessionAbsoluteLifetimeSeconds: number;
  readonly sessionIdleLifetimeSeconds: number;
  readonly transactionLifetimeSeconds: number;
}

export type FederatedSignInOutcome =
  | {
      readonly kind: "signed-in";
      readonly expiresAt: string;
      readonly principalId: Ulid;
      readonly sessionId: Ulid;
      readonly sessionToken: string;
    }
  | {
      readonly kind: "mailbox-confirmation-sent";
      readonly expiresAt: string;
      readonly maskedEmail: string;
    }
  | { readonly kind: "denied"; readonly reason: FederationDenial };

export class FederatedSignInContentionError extends Error {
  constructor() {
    super("Federated sign-in could not be completed because identity state kept changing.");
    this.name = "FederatedSignInContentionError";
  }
}

export type SignInPlan<Outcome> =
  | { readonly kind: "settled"; readonly outcome: Outcome }
  | {
      readonly kind: "write";
      readonly operations: readonly TransactionOperation[];
      readonly organizationEvents: readonly SemanticEventRecord[];
      readonly outcome: Outcome;
    };

/** What sign-in read about the organization and the asserted identity, before deciding to write. */
export interface SignInFacts {
  readonly assertion: FederatedAssertion;
  readonly byEmail: typeof PrincipalRecord.Type | undefined;
  readonly decision: Exclude<PrincipalDecision<DirectLinkEvidence>, { readonly kind: "denied" }>;
  readonly domain: OrganizationLoginDomainRecord;
  readonly linkRecord: typeof PrincipalIdentityRecord.Type | undefined;
  readonly linked: typeof PrincipalRecord.Type | undefined;
  readonly provider: OrganizationIdentityProviderRecord;
}

export type SignInResolution =
  | { readonly kind: "denied"; readonly reason: FederationDenial }
  | { readonly kind: "resolved"; readonly facts: SignInFacts };

export const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
export const plusSeconds = (at: Date, seconds: number) =>
  new Date(at.getTime() + seconds * 1_000).toISOString();

/**
 * Where the browser came from, as sign-in records keep it: hashes plus a coarse device label, and
 * only the fields the browser sent.
 */
export function requestSource(input: {
  readonly deviceLabel?: string | undefined;
  readonly ipPrefixHash?: string | undefined;
  readonly userAgentHash?: string | undefined;
}) {
  return {
    ...(input.deviceLabel ? { deviceLabel: input.deviceLabel } : {}),
    ...(input.ipPrefixHash ? { ipPrefixHash: input.ipPrefixHash } : {}),
    ...(input.userAgentHash ? { userAgentHash: input.userAgentHash } : {}),
  };
}

export function makeSignInPlanner(
  dependencies: FederatedSignInDependencies,
  config: FederatedSignInConfig,
): SignInPlanner {
  const reads = makeFederationReads(dependencies.database);
  const directory = makeDirectoryReads(dependencies.database);

  async function activeProvider(organizationId: Ulid) {
    const provider = await reads.provider(organizationId);
    return provider?.data.state.kind === "active" ? provider : undefined;
  }

  async function verifiedDomain(organizationId: Ulid, email: string | undefined) {
    const domain = normalizedEmailDomain(email);
    const record = domain ? await reads.loginDomain(organizationId, domain) : undefined;
    return record?.data.state.kind === "verified" ? record : undefined;
  }

  function identityEvent(input: {
    readonly aggregateId: Ulid;
    readonly aggregateType: string;
    readonly aggregateVersion: number;
    readonly eventType: string;
    readonly principalId: Ulid;
    readonly at: string;
  }): TransactionOperation {
    return {
      kind: "put",
      record: makeIdentitySecurityEventRecord({
        aggregateId: input.aggregateId,
        aggregateType: input.aggregateType,
        aggregateVersion: input.aggregateVersion,
        eventId: dependencies.generateId(),
        eventType: input.eventType,
        occurredAt: input.at,
        principalId: input.principalId,
      }),
    };
  }

  function sessionOperations(input: {
    readonly authentication: FederatedAuthentication;
    readonly at: Date;
    readonly ipPrefixHash?: string;
    readonly principalId: Ulid;
    readonly sessionEpoch: number;
    readonly deviceLabel?: string;
    readonly userAgentHash?: string;
  }) {
    const createdAt = input.at.toISOString();
    const sessionId = dependencies.generateId();
    const sessionToken = dependencies.newToken();
    const records = sessionRecords({
      authentication: input.authentication,
      authenticationTime: createdAt,
      createdAt,
      expiresAt: plusSeconds(input.at, config.sessionAbsoluteLifetimeSeconds),
      id: sessionId,
      idleExpiresAt: plusSeconds(input.at, config.sessionIdleLifetimeSeconds),
      ...requestSource(input),
      principalId: input.principalId,
      sessionEpoch: input.sessionEpoch,
      tokenHash: sha256(sessionToken),
    });
    const outcome: FederatedSignInOutcome = {
      expiresAt: records.session.data.expiresAt,
      kind: "signed-in",
      principalId: input.principalId,
      sessionId,
      sessionToken,
    };
    const operations: TransactionOperation[] = [
      { kind: "put", record: records.session },
      { kind: "put", record: records.locator },
      identityEvent({
        aggregateId: sessionId,
        aggregateType: "identity-session",
        aggregateVersion: 1,
        at: createdAt,
        eventType: "identity.session-created",
        principalId: input.principalId,
      }),
    ];
    return { operations, outcome };
  }

  async function membershipOperations(
    provider: OrganizationIdentityProviderRecord,
    principalId: Ulid,
    at: string,
  ) {
    const existing = await reads.member(provider.data.organizationId, principalId);
    const decision = jitMembership(existing?.data, provider.data.jit);
    if (decision.kind === "none") return { events: [], operations: [] };
    const change = memberActivation({
      at,
      existing: undefined,
      organizationId: provider.data.organizationId,
      principalId,
      role: decision.role,
      source: { kind: "identity-federation" },
    });
    return {
      events: change.events.map((event) =>
        makeSemanticEventRecord({
          ...event,
          actor: { id: principalId, type: "principal" },
          eventId: dependencies.generateId(),
          occurredAt: at,
        }),
      ),
      operations: change.operations,
    };
  }

  async function mailboxConfirmation(input: {
    readonly assertion: FederatedAssertion;
    readonly at: Date;
    readonly bindingHash: string;
    readonly principalId: Ulid;
    readonly primaryEmail: string;
    readonly provider: OrganizationIdentityProviderRecord;
  }) {
    const createdAt = input.at.toISOString();
    const expiresAt = plusSeconds(input.at, config.linkRequestLifetimeSeconds);
    const token = dependencies.newToken();
    const request = federationRecord("identity-federation-link-request", {
      bindingHash: input.bindingHash,
      connectionId: input.provider.data.connectionId,
      createdAt,
      expiresAt,
      id: dependencies.generateId(),
      issuer: input.assertion.issuer,
      organizationId: input.provider.data.organizationId,
      principalId: input.principalId,
      status: "pending",
      subject: input.assertion.subject,
      tokenHash: sha256(token),
      updatedAt: createdAt,
      version: 1,
    });
    const deliveryId = dependencies.generateId();
    const purpose = "federated-identity-link";
    const delivery = pendingEmailDeliveryRecord({
      createdAt,
      dispatchShard: identityEmailDeliveryShard(deliveryId),
      expiresAt,
      id: deliveryId,
      principalId: input.principalId,
      protectedPayload: await dependencies.encryptEmailPayload(
        { actionToken: token, recipient: input.primaryEmail, schemaVersion: 1 },
        identityEmailDeliveryBinding({ id: deliveryId, purpose }),
      ),
      purpose,
    });
    const operations: TransactionOperation[] = [
      { kind: "put", record: request },
      { kind: "put", record: delivery },
      identityEvent({
        aggregateId: request.data.id,
        aggregateType: "identity-federation-link-request",
        aggregateVersion: 1,
        at: createdAt,
        eventType: "identity.federated-link-requested",
        principalId: input.principalId,
      }),
    ];
    const outcome: FederatedSignInOutcome = {
      expiresAt,
      kind: "mailbox-confirmation-sent",
      maskedEmail: maskedEmail(input.primaryEmail),
    };
    return { operations, outcome };
  }

  /**
   * Admits the assertion only from the organization's active provider on the attempt's connection,
   * speaking the same protocol as that provider and naming its issuer.
   */
  async function resolve(input: {
    readonly assertion: FederatedAssertion;
    readonly connectionId: Ulid;
    readonly organizationId: Ulid;
  }): Promise<SignInResolution> {
    const { assertion } = input;
    const provider = await activeProvider(input.organizationId);
    if (
      !provider ||
      provider.data.connectionId !== input.connectionId ||
      identityProviderProtocol(provider.data) !== assertion.protocol ||
      provider.data.issuer !== assertion.issuer
    ) {
      return { kind: "denied", reason: "connection_inactive" };
    }
    const linkRecord = await reads.link(linkAnchor(provider.data), assertion.subject);
    const [linked, byEmail] = await Promise.all([
      linkRecord ? reads.principal(linkRecord.data.principalId) : Promise.resolve(undefined),
      linkRecord ? Promise.resolve(undefined) : reads.principalForEmail(assertion.email),
    ]);
    const [domain, provisioned] = await Promise.all([
      verifiedDomain(
        provider.data.organizationId,
        linked ? linked.data.primaryEmail : assertion.email,
      ),
      byEmail
        ? provisionedStanding({
            directory,
            organizationId: provider.data.organizationId,
            principal: byEmail,
            reads,
          })
        : undefined,
    ]);
    const decision = decidePrincipal({
      assertion,
      link: linkRecord ? linked?.data : undefined,
      principalByEmail: byEmail?.data,
      provisioned,
      verifiedDomains: new Set(domain ? [domain.data.domain] : []),
    });
    if (decision.kind === "denied") return decision;
    if (!domain) return { kind: "denied", reason: "email_domain_not_verified" };
    return {
      facts: { assertion, byEmail, decision, domain, linkRecord, linked, provider },
      kind: "resolved",
    };
  }

  /**
   * `consume` makes the attempt one-shot inside the same transaction; `bindingHash` ties a mailbox
   * confirmation to the browser that started it.
   */
  async function plan(input: SignInPlanInput): Promise<SignInPlan<FederatedSignInOutcome>> {
    const { assertion, byEmail, decision, domain, linkRecord, linked, provider } = input.facts;
    const denied = (reason: FederationDenial) =>
      ({ kind: "settled", outcome: { kind: "denied", reason } }) as const;
    const at = dependencies.now();
    const createdAt = at.toISOString();
    const authentication: FederatedAuthentication = {
      authenticatedAt: createdAt,
      connectionId: provider.data.connectionId,
      issuer: assertion.issuer,
      method: "federated",
      organizationId: provider.data.organizationId,
      subject: assertion.subject,
    };
    const pins = [...input.consume, versionPin(provider), versionPin(domain)];
    const session = { at, authentication, ...requestSource(input) };

    switch (decision.kind) {
      case "confirm-mailbox": {
        if (!byEmail?.data.primaryEmail) {
          return denied("principal_ineligible");
        }
        const confirmation = await mailboxConfirmation({
          assertion,
          at,
          bindingHash: input.bindingHash,
          primaryEmail: byEmail.data.primaryEmail,
          principalId: decision.principalId,
          provider,
        });
        return {
          kind: "write",
          operations: [...pins, versionPin(byEmail), ...confirmation.operations],
          organizationEvents: [],
          outcome: confirmation.outcome,
        };
      }
      case "link": {
        const { evidence, principalId } = decision;
        const link = federationRecord("principal-identity", {
          ...linkAnchor(provider.data),
          createdAt,
          email: assertion.email,
          id: dependencies.generateId(),
          organizationId: provider.data.organizationId,
          principalId,
          subject: assertion.subject,
          updatedAt: createdAt,
          version: 1,
        });
        const signedIn = sessionOperations({
          ...session,
          principalId,
          sessionEpoch: evidence.security.data.sessionEpoch + 1,
        });
        return {
          kind: "write",
          operations: [
            ...pins,
            ...directLinkConditions(evidence),
            ...createWithClaims(link, createdAt),
            identityEvent({
              aggregateId: link.data.id,
              aggregateType: "principal-identity",
              aggregateVersion: 1,
              at: createdAt,
              eventType: "identity.federated-identity-linked",
              principalId,
            }),
            ...endPrincipalSessions({
              at: createdAt,
              eventId: dependencies.generateId(),
              fence: evidence.fence,
              security: evidence.security,
            }),
            ...signedIn.operations,
          ],
          organizationEvents: [],
          outcome: signedIn.outcome,
        };
      }
      case "sign-in": {
        const security = await reads.securityState(decision.principalId);
        if (!linked || !linkRecord || !security) return denied("principal_ineligible");
        const membership = await membershipOperations(provider, decision.principalId, createdAt);
        const signedIn = sessionOperations({
          ...session,
          principalId: decision.principalId,
          sessionEpoch: security.data.sessionEpoch,
        });
        return {
          kind: "write",
          operations: [
            ...pins,
            versionPin(linked),
            versionPin(linkRecord),
            versionPin(security),
            ...membership.operations,
            ...signedIn.operations,
          ],
          organizationEvents: membership.events,
          outcome: signedIn.outcome,
        };
      }
      case "create": {
        const principalId = dependencies.generateId();
        const link = federationRecord("principal-identity", {
          ...linkAnchor(provider.data),
          createdAt,
          email: assertion.email,
          id: dependencies.generateId(),
          organizationId: provider.data.organizationId,
          principalId,
          subject: assertion.subject,
          updatedAt: createdAt,
          version: 1,
        });
        const membership = await membershipOperations(provider, principalId, createdAt);
        const signedIn = sessionOperations({ ...session, principalId, sessionEpoch: 0 });
        return {
          kind: "write",
          operations: [
            ...pins,
            ...newHumanPrincipalOperations({
              createdAt,
              ...(assertion.displayName ? { displayName: assertion.displayName } : {}),
              eventId: dependencies.generateId(),
              mailbox: "verified",
              primaryEmail: assertion.email,
              principalId,
            }),
            ...createWithClaims(link, createdAt),
            identityEvent({
              aggregateId: link.data.id,
              aggregateType: "principal-identity",
              aggregateVersion: 1,
              at: createdAt,
              eventType: "identity.federated-identity-linked",
              principalId,
            }),
            ...membership.operations,
            ...signedIn.operations,
          ],
          organizationEvents: membership.events,
          outcome: signedIn.outcome,
        };
      }
      default: {
        const unhandled: never = decision;
        return unhandled;
      }
    }
  }

  /** Re-plans on a write conflict, so a racing writer is seen before the next attempt. */
  async function commit<Outcome>(planOnce: () => Promise<SignInPlan<Outcome>>): Promise<Outcome> {
    for (let attempt = 0; attempt < SIGN_IN_WRITE_ATTEMPTS; attempt += 1) {
      const next = await planOnce();
      if (next.kind === "settled") return next.outcome;
      try {
        await transactWithSemanticEvents(
          dependencies.database,
          next.operations,
          next.organizationEvents,
        );
        return next.outcome;
      } catch (error) {
        if (!isDatabaseWriteConflict(error)) throw error;
      }
    }
    throw new FederatedSignInContentionError();
  }

  return { activeProvider, commit, plan, reads, resolve };
}

export interface SignInPlanInput {
  readonly bindingHash: string;
  readonly consume: readonly TransactionOperation[];
  readonly facts: SignInFacts;
  readonly ipPrefixHash?: string;
  readonly deviceLabel?: string;
  readonly userAgentHash?: string;
}

export interface SignInPlanner {
  readonly activeProvider: (
    organizationId: Ulid,
  ) => Promise<OrganizationIdentityProviderRecord | undefined>;
  readonly commit: <Outcome>(planOnce: () => Promise<SignInPlan<Outcome>>) => Promise<Outcome>;
  readonly plan: (input: SignInPlanInput) => Promise<SignInPlan<FederatedSignInOutcome>>;
  readonly reads: FederationReads;
  readonly resolve: (input: {
    readonly assertion: FederatedAssertion;
    readonly connectionId: Ulid;
    readonly organizationId: Ulid;
  }) => Promise<SignInResolution>;
}
