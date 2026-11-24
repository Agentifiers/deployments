import type { DynamoDatabaseService, TransactionOperation } from "../client-types.ts";
import { makeIdGenerator, type Ulid } from "../ids.ts";
import { makeFederationReads } from "../identity-federation/reads.ts";
import { PersistenceError } from "../persistence-types.ts";
import { isDatabaseWriteConflict } from "../transaction-conditions.ts";
import {
  makeIdentitySecurityEventRecord,
  transactWithIdentitySecurityEvents,
} from "./security-events.ts";

const MAX_ATTEMPTS = 5;

export type PrincipalStatusTarget = "active" | "disabled";

export interface PrincipalStatusChange {
  /** The platform administrator making the change. */
  readonly actorPrincipalId: Ulid;
  readonly principalId: Ulid;
  readonly reason: string;
  readonly status: PrincipalStatusTarget;
}

export interface PrincipalStatusOutcome {
  /** false when the principal already had the requested status, so nothing was written. */
  readonly changed: boolean;
  readonly principalId: Ulid;
  readonly status: PrincipalStatusTarget;
  readonly updatedAt: string;
}

export interface PrincipalStatusRepository {
  /**
   * Sets a person's status. Disabling also advances their session epoch, which ends every browser
   * session, refresh token family, and device grant they hold.
   */
  readonly setStatus: (change: PrincipalStatusChange) => Promise<PrincipalStatusOutcome>;
}

export function makePrincipalStatusRepository(dependencies: {
  readonly database: DynamoDatabaseService;
  readonly generateId?: () => Ulid;
  readonly now?: () => Date;
}): PrincipalStatusRepository {
  const { database } = dependencies;
  const ids = makeIdGenerator();
  const generateId = dependencies.generateId ?? (() => ids.generate());
  const now = dependencies.now ?? (() => new Date());
  const reads = makeFederationReads(database);

  async function attempt(change: PrincipalStatusChange): Promise<PrincipalStatusOutcome> {
    const { principalId, status } = change;
    const [principal, security, fence] = await Promise.all([
      reads.principal(principalId),
      reads.securityState(principalId),
      reads.bffFence(principalId),
    ]);
    if (principal?.data.kind !== "human") {
      throw new PersistenceError(
        "not-found",
        "principal_not_found",
        "No person has that principal ID.",
      );
    }
    if (principal.data.status === "archived") {
      throw new PersistenceError(
        "conflict",
        "principal_archived",
        "The person's principal is archived, so its status cannot change.",
      );
    }
    if (principal.data.status === status) {
      return { changed: false, principalId, status, updatedAt: principal.data.updatedAt };
    }
    if (!security || !fence) {
      throw new PersistenceError(
        "conflict",
        "principal_sign_in_state_missing",
        "The person has no platform identity sign-in state to change.",
      );
    }
    const at = now().toISOString();
    const principalVersion = principal.data.version + 1;
    const sessionEpoch =
      status === "disabled" ? security.data.sessionEpoch + 1 : fence.data.sessionEpoch;
    const securityVersion = security.data.version + 1;
    const operations: TransactionOperation[] = [
      {
        kind: "put",
        previousRecord: principal,
        record: {
          ...principal,
          data: { ...principal.data, status, updatedAt: at, version: principalVersion },
        },
      },
      {
        kind: "put",
        previousRecord: fence,
        record: {
          ...fence,
          data: {
            ...fence.data,
            principalStatus: status,
            sessionEpoch,
            updatedAt: at,
            version: fence.data.version + 1,
          },
        },
      },
    ];
    const events = [
      makeIdentitySecurityEventRecord({
        actor: { id: change.actorPrincipalId, type: "principal" },
        aggregateId: principalId,
        aggregateType: "principal",
        aggregateVersion: principalVersion,
        eventId: generateId(),
        eventType:
          status === "disabled" ? "identity.principal-disabled" : "identity.principal-enabled",
        occurredAt: at,
        payload: { reason: change.reason, status },
        principalId,
      }),
    ];
    if (status === "disabled") {
      operations.push({
        kind: "put",
        previousRecord: security,
        record: {
          ...security,
          data: { ...security.data, sessionEpoch, updatedAt: at, version: securityVersion },
        },
      });
      events.push(
        makeIdentitySecurityEventRecord({
          actor: { id: change.actorPrincipalId, type: "principal" },
          aggregateId: principalId,
          aggregateType: "principal-security-state",
          aggregateVersion: securityVersion,
          eventId: generateId(),
          eventType: "identity.sessions-invalidated",
          occurredAt: at,
          principalId,
        }),
      );
    }
    await transactWithIdentitySecurityEvents(database, operations, events);
    return { changed: true, principalId, status, updatedAt: at };
  }

  return {
    async setStatus(change) {
      if (change.status === "disabled" && change.principalId === change.actorPrincipalId) {
        throw new PersistenceError(
          "forbidden",
          "cannot_disable_self",
          "A platform administrator cannot disable their own principal.",
        );
      }
      for (let attempts = 1; ; attempts += 1) {
        try {
          return await attempt(change);
        } catch (cause) {
          if (attempts >= MAX_ATTEMPTS || !isDatabaseWriteConflict(cause)) throw cause;
        }
      }
    },
  };
}
