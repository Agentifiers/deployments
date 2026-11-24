import {
  isDatabaseWriteConflict,
  makeIdentitySecurityEventRecord,
  type IdentityRepository,
  type TransactionOperation,
  type Ulid,
  withCanonicalRecordKeys,
} from "@deployments-ai/db";
import { IdentityError, sha256 } from "@deployments-ai/identity";
import { authenticateClient, REFRESH_WRITE_ATTEMPTS } from "./oauth-application-support.ts";

export interface OAuthRevocationDependencies {
  readonly generateId: () => Ulid;
  readonly now?: () => Date;
  readonly repository: IdentityRepository;
}

export function makeOAuthRevocationApplication(dependencies: OAuthRevocationDependencies) {
  const now = dependencies.now ?? (() => new Date());

  async function revokeRefreshToken(
    input: {
      readonly clientId: string;
      readonly clientSecret?: string;
      readonly refreshToken: string;
    },
    writeAttempt = 0,
  ): Promise<void> {
    const client = await dependencies.repository.clientForId(input.clientId);
    if (!client || client.data.status !== "active") {
      throw new IdentityError("invalid_client", "Client authentication failed.");
    }
    authenticateClient(client, input.clientSecret, now);
    const token = await dependencies.repository.refreshTokenForHash(sha256(input.refreshToken));
    if (!token) return;
    const family = await dependencies.repository.refreshFamilyForId(token.data.familyId);
    if (!family || family.data.clientId !== input.clientId || family.data.status !== "active") {
      return;
    }
    const revokedAt = now().toISOString();
    // The family's GSI1 sort key embeds its status, so the revoked record is re-keyed.
    const revokedFamily = withCanonicalRecordKeys({
      ...family,
      data: {
        ...family.data,
        revocationReason: "client-request",
        revokedAt,
        status: "revoked" as const,
        updatedAt: revokedAt,
        version: family.data.version + 1,
      },
    });
    const operations: TransactionOperation[] = [
      { kind: "put", previousRecord: family, record: revokedFamily },
    ];
    if (token.data.status === "active") {
      operations.push({
        kind: "put",
        previousRecord: token,
        record: {
          ...token,
          data: {
            ...token.data,
            status: "revoked",
            updatedAt: revokedAt,
            version: token.data.version + 1,
          },
        },
      });
    }
    operations.push({
      kind: "put",
      record: makeIdentitySecurityEventRecord({
        aggregateId: family.data.id,
        aggregateType: "oauth-refresh-family",
        aggregateVersion: revokedFamily.data.version,
        eventId: dependencies.generateId(),
        eventType: "identity.refresh-revoked",
        occurredAt: revokedAt,
        principalId: family.data.principalId,
        payload: { clientId: input.clientId, generation: token.data.generation },
      }),
    });
    try {
      await dependencies.repository.transact(operations);
    } catch (error) {
      if (!isDatabaseWriteConflict(error)) throw error;
      const observed = await dependencies.repository.refreshFamilyForId(family.data.id);
      if (
        !observed ||
        observed.data.clientId !== input.clientId ||
        observed.data.status !== "active"
      ) {
        return;
      }
      if (writeAttempt + 1 < REFRESH_WRITE_ATTEMPTS) {
        return revokeRefreshToken(input, writeAttempt + 1);
      }
      throw new IdentityError(
        "temporarily_unavailable",
        "The refresh token could not be revoked because identity state kept changing.",
        { status: 503 },
      );
    }
  }

  return { revokeRefreshToken };
}
