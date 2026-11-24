import {
  isDatabaseWriteConflict,
  makeIdentitySecurityEventRecord,
  pendingEmailDeliveryRecord,
  withCanonicalRecordKeys,
  type IdentityRecord,
  type IdentityRepository,
  type PlatformRecord,
  type ProtectedEnvelope,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import { deliveryShard } from "./email-delivery-shard.ts";
import { plusSeconds } from "./time-arithmetic.ts";

const put = (record: PlatformRecord): TransactionOperation => ({ kind: "put", record });

export function makeRefreshReuseApplication(
  dependencies: {
    readonly encryptEmailPayload: (
      value: unknown,
      context: Readonly<Record<string, string>>,
    ) => Promise<ProtectedEnvelope>;
    readonly generateId: () => Ulid;
    readonly now: () => Date;
    readonly reportSecurityNotificationFailure?: (cause: unknown) => void;
    readonly repository: IdentityRepository;
  },
  notificationLifetimeSeconds: number,
) {
  async function prepareNotification(
    family: IdentityRecord<"oauth-refresh-family">,
    timestamp: Date,
  ) {
    try {
      const principal = await dependencies.repository.principalForId(family.data.principalId);
      const recipient = principal?.data.kind === "human" ? principal.data.primaryEmail : undefined;
      if (!recipient) return undefined;
      const deliveryId = dependencies.generateId();
      return pendingEmailDeliveryRecord({
        createdAt: timestamp.toISOString(),
        dispatchShard: deliveryShard(deliveryId),
        expiresAt: plusSeconds(timestamp, notificationLifetimeSeconds),
        id: deliveryId,
        principalId: family.data.principalId,
        protectedPayload: await dependencies.encryptEmailPayload(
          { recipient, schemaVersion: 1 },
          { deliveryId, purpose: "suspicious-refresh-reuse" },
        ),
        purpose: "suspicious-refresh-reuse",
      });
    } catch (cause) {
      try {
        dependencies.reportSecurityNotificationFailure?.(cause);
      } catch {
        // Revocation must not depend on optional notification reporting either.
      }
      return undefined;
    }
  }

  async function compromiseRefreshFamily(
    family: IdentityRecord<"oauth-refresh-family">,
    token: IdentityRecord<"oauth-refresh-token">,
    clientId: string,
  ) {
    if (family.data.status !== "active") return;
    const timestamp = dependencies.now();
    const updatedAt = timestamp.toISOString();
    const compromised = withCanonicalRecordKeys({
      ...family,
      data: {
        ...family.data,
        revocationReason: "refresh-token-reuse",
        revokedAt: updatedAt,
        status: "compromised" as const,
        updatedAt,
        version: family.data.version + 1,
      },
    });
    const delivery = await prepareNotification(family, timestamp);
    try {
      await dependencies.repository.transact([
        { kind: "put", previousRecord: family, record: compromised },
        ...(delivery ? [put(delivery)] : []),
        put(
          makeIdentitySecurityEventRecord({
            aggregateId: family.data.id,
            aggregateType: "oauth-refresh-family",
            aggregateVersion: compromised.data.version,
            eventId: dependencies.generateId(),
            eventType: "identity.refresh-reuse-detected",
            occurredAt: updatedAt,
            principalId: family.data.principalId,
            payload: { clientId, generation: token.data.generation },
          }),
        ),
      ]);
    } catch (error) {
      if (!isDatabaseWriteConflict(error)) throw error;
      const observed = await dependencies.repository.refreshFamilyForId(family.data.id);
      if (observed?.data.status !== "compromised") throw error;
    }
  }

  return { compromiseRefreshFamily };
}
