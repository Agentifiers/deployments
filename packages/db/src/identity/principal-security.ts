import { emailClaimValue } from "@deployments-ai/identity";
import type { DynamoDatabaseService } from "../client-types.ts";
import { makeIdGenerator, type Ulid } from "../ids.ts";
import { makeFederationReads } from "../identity-federation/reads.ts";
import { PersistenceError } from "../persistence-types.ts";
import { isDatabaseWriteConflict } from "../transaction-conditions.ts";
import type {
  PendingSignUp,
  PrincipalMfaState,
  PrincipalSessionsEnded,
  PrincipalSignIn,
} from "./principal-commands.ts";
import { makeIdentityRepository } from "./repository.ts";
import {
  makeIdentitySecurityEventRecord,
  transactWithIdentitySecurityEvents,
} from "./security-events.ts";

const MAX_ATTEMPTS = 5;
/** One query page of each listing; `capped` says the person may hold more. */
export const PRINCIPAL_SESSION_COUNT_LIMIT = 100;

export interface PrincipalSessionRevocation {
  readonly actorPrincipalId: Ulid;
  readonly principalId: Ulid;
  readonly reason: string;
}

export interface PrincipalSecurityRepository {
  /** `undefined` when platform identity holds no sign-in state for the principal. */
  readonly describe: (principalId: Ulid) => Promise<PrincipalSignIn | undefined>;
  /** The unexpired sign-up for this normalized email that no principal holds yet. */
  readonly pendingSignUp: (normalizedEmail: string) => Promise<PendingSignUp | undefined>;
  /**
   * Advances the session epoch, which ends every browser session, refresh token family, and
   * device grant. Every call advances it again, so a repeat is harmless and always writes.
   */
  readonly revokeSessions: (change: PrincipalSessionRevocation) => Promise<PrincipalSessionsEnded>;
}

export function makePrincipalSecurityRepository(dependencies: {
  readonly database: DynamoDatabaseService;
  readonly generateId?: () => Ulid;
  readonly now?: () => Date;
}): PrincipalSecurityRepository {
  const { database } = dependencies;
  const ids = makeIdGenerator();
  const generateId = dependencies.generateId ?? (() => ids.generate());
  const now = dependencies.now ?? (() => new Date());
  const reads = makeFederationReads(database);
  const identity = makeIdentityRepository(database);

  function mfaState(
    factor: Awaited<ReturnType<typeof identity.mfaFactorForPrincipal>>,
  ): PrincipalMfaState {
    switch (factor?.data.state) {
      case undefined:
        return { state: "none" };
      case "pending":
        return { since: factor.data.createdAt, state: "pending" };
      case "active":
        return {
          activatedAt: factor.data.activatedAt,
          recoveryCodesRemaining: factor.data.recoveryCodes.filter((code) => !code.usedAt).length,
          state: "active",
        };
      case "disabled":
        return { disabledAt: factor.data.disabledAt, state: "disabled" };
    }
  }

  async function revokeOnce(change: PrincipalSessionRevocation): Promise<PrincipalSessionsEnded> {
    const { principalId } = change;
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
        "The person's principal is archived, so it holds no sessions.",
      );
    }
    if (!security || !fence) {
      throw new PersistenceError(
        "conflict",
        "principal_sign_in_state_missing",
        "The person has no platform identity sign-in state to change.",
      );
    }
    const at = now().toISOString();
    const sessionEpoch = security.data.sessionEpoch + 1;
    const version = security.data.version + 1;
    await transactWithIdentitySecurityEvents(
      database,
      [
        {
          kind: "put",
          previousRecord: security,
          record: { ...security, data: { ...security.data, sessionEpoch, updatedAt: at, version } },
        },
        {
          kind: "put",
          previousRecord: fence,
          record: {
            ...fence,
            data: { ...fence.data, sessionEpoch, updatedAt: at, version: fence.data.version + 1 },
          },
        },
      ],
      [
        makeIdentitySecurityEventRecord({
          actor: { id: change.actorPrincipalId, type: "principal" },
          aggregateId: principalId,
          aggregateType: "principal-security-state",
          aggregateVersion: version,
          eventId: generateId(),
          eventType: "identity.sessions-invalidated",
          occurredAt: at,
          payload: { reason: change.reason },
          principalId,
        }),
      ],
    );
    return { principalId, sessionsEndedAt: at };
  }

  return {
    async describe(principalId) {
      const security = await reads.securityState(principalId);
      if (!security) return undefined;
      const [factor, sessions, families] = await Promise.all([
        identity.mfaFactorForPrincipal(principalId),
        identity.listActiveSessions(principalId, { limit: PRINCIPAL_SESSION_COUNT_LIMIT }),
        identity.listRefreshFamilies(principalId, PRINCIPAL_SESSION_COUNT_LIMIT),
      ]);
      const at = now().getTime();
      const epoch = security.data.sessionEpoch;
      const browser = sessions.items.filter(
        (session) =>
          session.data.sessionEpoch === epoch &&
          Date.parse(session.data.expiresAt) > at &&
          Date.parse(session.data.idleExpiresAt) > at,
      ).length;
      const refreshFamilies = families.items.filter(
        (record) =>
          record.itemType === "oauth-refresh-family" &&
          record.data.principalId === principalId &&
          record.data.status === "active" &&
          record.data.sessionEpoch === epoch &&
          Date.parse(record.data.expiresAt) > at,
      ).length;
      return {
        ...(security.data.emailVerifiedAt
          ? { emailVerifiedAt: security.data.emailVerifiedAt }
          : {}),
        mfa: mfaState(factor),
        sessions: {
          browser,
          capped: sessions.next !== undefined || families.lastEvaluatedKey !== undefined,
          refreshFamilies,
        },
      };
    },
    async pendingSignUp(normalizedEmail) {
      const emailHash = emailClaimValue(normalizedEmail);
      const [registration, principal] = await Promise.all([
        identity.registrationForEmailHash(emailHash),
        identity.principalForEmailHash(emailHash),
      ]);
      if (
        !registration ||
        principal ||
        Date.parse(registration.data.expiresAt) <= now().getTime()
      ) {
        return undefined;
      }
      return {
        createdAt: registration.data.createdAt,
        email: registration.data.email,
        expiresAt: registration.data.expiresAt,
        principalId: registration.data.id,
        verificationEmailSentAt: registration.data.verificationEmailSentAt,
      };
    },
    async revokeSessions(change) {
      for (let attempts = 1; ; attempts += 1) {
        try {
          return await revokeOnce(change);
        } catch (cause) {
          if (attempts >= MAX_ATTEMPTS || !isDatabaseWriteConflict(cause)) throw cause;
        }
      }
    },
  };
}
