import {
  isDatabaseWriteConflict,
  makeIdentitySecurityEventRecord,
  withCanonicalRecordKeys,
  type IdentityRecord,
  type IdentityRepository,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import { IdentityError, sha256 } from "@deployments-ai/identity";

const SESSION_REVOCATION_WRITE_ATTEMPTS = 5;

export interface SessionRevocationDependencies {
  readonly generateId: () => Ulid;
  readonly now?: () => Date;
  readonly repository: IdentityRepository;
}

/** An active browser session plus its locator when the locator still points at it. */
export interface SessionRevocationTarget {
  readonly locator: IdentityRecord<"identity-session-locator"> | undefined;
  readonly session: IdentityRecord<"identity-session">;
}

export function matchingActiveLocator(
  session: IdentityRecord<"identity-session">,
  locator: IdentityRecord<"identity-session-locator"> | undefined,
) {
  return locator?.data.status === "active" &&
    locator.data.principalId === session.data.principalId &&
    locator.data.sessionId === session.data.id &&
    locator.data.sessionTokenHash === session.data.tokenHash
    ? locator
    : undefined;
}

function revocationOperations(
  target: SessionRevocationTarget,
  revokedAt: string,
  eventId: Ulid,
): TransactionOperation[] {
  const { locator, session } = target;
  // The session GSI1 sort key embeds its status, so the revoked record is re-keyed.
  const revokedSession = withCanonicalRecordKeys({
    ...session,
    data: {
      ...session.data,
      revokedAt,
      status: "revoked" as const,
      updatedAt: revokedAt,
      version: session.data.version + 1,
    },
  });
  const operations: TransactionOperation[] = [
    { kind: "put", previousRecord: session, record: revokedSession },
  ];
  if (locator) {
    operations.push({
      kind: "put",
      previousRecord: locator,
      record: withCanonicalRecordKeys({
        ...locator,
        data: {
          ...locator.data,
          revokedAt,
          status: "revoked" as const,
          updatedAt: revokedAt,
          version: locator.data.version + 1,
        },
      }),
    });
  }
  operations.push({
    kind: "put",
    record: makeIdentitySecurityEventRecord({
      aggregateId: session.data.id,
      aggregateType: "identity-session",
      aggregateVersion: revokedSession.data.version,
      eventId,
      eventType: "identity.session-revoked",
      occurredAt: revokedAt,
      principalId: session.data.principalId,
    }),
  });
  return operations;
}

/**
 * Revokes the session returned by `load` (and its matching locator) with a security event in
 * one transaction. `load` is re-run after every write conflict; returning `undefined` means the
 * session is already ended, which is treated as success.
 */
export async function revokeBrowserSession(
  dependencies: SessionRevocationDependencies,
  load: () => Promise<SessionRevocationTarget | undefined>,
) {
  const now = dependencies.now ?? (() => new Date());
  for (let attempt = 0; attempt < SESSION_REVOCATION_WRITE_ATTEMPTS; attempt += 1) {
    const target = await load();
    if (!target) return;
    const operations = revocationOperations(target, now().toISOString(), dependencies.generateId());
    try {
      await dependencies.repository.transact(operations);
      return;
    } catch (error) {
      if (!isDatabaseWriteConflict(error)) throw error;
    }
  }
  if (!(await load())) return;
  throw new IdentityError(
    "temporarily_unavailable",
    "The browser session could not be revoked because identity state kept changing.",
    { status: 503 },
  );
}

export function makeSessionRevocationApplication(dependencies: SessionRevocationDependencies) {
  async function signOut(rawSessionToken: string) {
    if (!rawSessionToken) return;
    const tokenHash = sha256(rawSessionToken);
    await revokeBrowserSession(dependencies, async () => {
      const session = await dependencies.repository.sessionForHash(tokenHash);
      if (!session || session.data.status !== "active") return undefined;
      const locator = await dependencies.repository.sessionLocator(
        session.data.principalId,
        session.data.id,
      );
      return { locator: matchingActiveLocator(session, locator), session };
    });
  }

  return { signOut };
}
