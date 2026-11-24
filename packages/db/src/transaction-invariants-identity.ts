import type { DatabaseError, TransactionOperation, TransactionPut } from "./client-types.ts";
import { databaseFailure, recordVersion } from "./transaction-conditions.ts";

export function identityTransactionInvariantViolation(
  operations: readonly TransactionOperation[],
): DatabaseError | undefined {
  const puts = operations.filter(
    (operation): operation is TransactionPut => operation.kind === "put",
  );
  const identityEventPuts = puts.filter(
    (operation) => operation.record.itemType === "identity-security-event",
  );
  const identityAggregatePartitions = new Set<string>();
  for (const operation of identityEventPuts) {
    if (identityAggregatePartitions.has(operation.record.pk)) {
      return databaseFailure(
        "transact-write",
        "events",
        "One transaction may append at most one identity security event per aggregate.",
      );
    }
    identityAggregatePartitions.add(operation.record.pk);

    const eventData = operation.record.data as Readonly<Record<string, unknown>>;
    const aggregate = puts.find((candidate) => {
      if (candidate === operation || candidate.record.itemType !== eventData.aggregateType) {
        return false;
      }
      const aggregateData = candidate.record.data as Readonly<Record<string, unknown>>;
      const aggregateId =
        candidate.record.itemType === "principal-security-state"
          ? aggregateData.principalId
          : aggregateData.id;
      return aggregateId === eventData.aggregateId;
    });
    const aggregateVersion = aggregate ? recordVersion(aggregate.record) : undefined;
    const eventAggregateVersion = eventData.aggregateVersion;
    const previousAggregateVersion = aggregate?.previousRecord
      ? recordVersion(aggregate.previousRecord)
      : undefined;
    const hasMatchingMutation =
      typeof eventAggregateVersion === "number" &&
      aggregateVersion === eventAggregateVersion &&
      (eventAggregateVersion === 1
        ? aggregate?.previousRecord === undefined
        : previousAggregateVersion === eventAggregateVersion - 1);
    if (!hasMatchingMutation) {
      return databaseFailure(
        "transact-write",
        "events",
        "Identity security events must accompany the exact aggregate version mutation.",
      );
    }
  }

  const createdActions = puts.filter(
    (operation) => operation.record.itemType === "identity-action" && !operation.previousRecord,
  );
  const createdDeliveries = puts.filter(
    (operation) =>
      operation.record.itemType === "identity-email-delivery" && !operation.previousRecord,
  );
  for (const action of createdActions) {
    const actionData = action.record.data as Readonly<Record<string, unknown>>;
    if (
      !createdDeliveries.some(
        (delivery) =>
          (delivery.record.data as Readonly<Record<string, unknown>>).actionId === actionData.id,
      )
    ) {
      return databaseFailure(
        "transact-write",
        "multiple",
        "Identity action creation requires its protected email delivery in the same transaction.",
      );
    }
  }
  for (const delivery of createdDeliveries) {
    const deliveryData = delivery.record.data as Readonly<Record<string, unknown>>;
    if (
      deliveryData.actionId &&
      !createdActions.some(
        (action) =>
          (action.record.data as Readonly<Record<string, unknown>>).id === deliveryData.actionId,
      )
    ) {
      return databaseFailure(
        "transact-write",
        "multiple",
        "Action email delivery creation requires its identity action in the same transaction.",
      );
    }
    if (
      deliveryData.invitationId &&
      !puts.some((candidate) => {
        const invitation = candidate.record.data as Readonly<Record<string, unknown>>;
        return (
          candidate.record.itemType === "organization-invitation" &&
          !candidate.previousRecord &&
          invitation.id === deliveryData.invitationId &&
          invitation.organizationId === deliveryData.organizationId
        );
      })
    ) {
      return databaseFailure(
        "transact-write",
        "multiple",
        "Invitation email delivery creation requires its organization invitation in the same transaction.",
      );
    }
  }

  const securityStatePuts = puts.filter(
    (operation) => operation.record.itemType === "principal-security-state",
  );
  const principalPuts = puts.filter((operation) => operation.record.itemType === "principal");
  const fencePuts = puts.filter(
    (operation) => operation.record.itemType === "identity-bff-revocation-fence",
  );
  for (const fence of fencePuts) {
    const fenceData = fence.record.data as Readonly<Record<string, unknown>>;
    const previousFenceData =
      fence.previousRecord?.itemType === "identity-bff-revocation-fence"
        ? (fence.previousRecord.data as Readonly<Record<string, unknown>>)
        : undefined;
    const principal = principalPuts.find(
      (operation) =>
        (operation.record.data as Readonly<Record<string, unknown>>).id === fenceData.principalId,
    );
    const security = securityStatePuts.find(
      (operation) =>
        (operation.record.data as Readonly<Record<string, unknown>>).principalId ===
        fenceData.principalId,
    );
    const expectedStatus =
      (principal?.record.data as Readonly<Record<string, unknown>> | undefined)?.status ??
      previousFenceData?.principalStatus;
    const expectedEpoch =
      (security?.record.data as Readonly<Record<string, unknown>> | undefined)?.sessionEpoch ??
      previousFenceData?.sessionEpoch;
    if (
      expectedStatus === undefined ||
      expectedEpoch === undefined ||
      fenceData.principalStatus !== expectedStatus ||
      fenceData.sessionEpoch !== expectedEpoch
    ) {
      return databaseFailure(
        "transact-write",
        "control",
        "BFF revocation fences must project the authoritative principal status and session epoch.",
      );
    }
  }
  for (const principal of principalPuts) {
    if (!principal.previousRecord || principal.previousRecord.itemType !== "principal") continue;
    const principalData = principal.record.data as Readonly<Record<string, unknown>>;
    const previousPrincipalData = principal.previousRecord.data as Readonly<
      Record<string, unknown>
    >;
    if (principalData.kind !== "human") continue;
    if (previousPrincipalData.status === principalData.status) continue;
    const fence = fencePuts.find(
      (operation) =>
        (operation.record.data as Readonly<Record<string, unknown>>).principalId ===
        principalData.id,
    );
    const fenceData = fence?.record.data as Readonly<Record<string, unknown>> | undefined;
    if (!fence || fenceData?.principalStatus !== principalData.status) {
      return databaseFailure(
        "transact-write",
        "control",
        "Principal status changes require a matching BFF revocation fence put.",
      );
    }
  }
  for (const security of securityStatePuts) {
    const securityData = security.record.data as Readonly<Record<string, unknown>>;
    const previousSecurityData = security.previousRecord?.data as
      | Readonly<Record<string, unknown>>
      | undefined;
    const epochChanged =
      !security.previousRecord ||
      security.previousRecord.itemType !== "principal-security-state" ||
      previousSecurityData?.sessionEpoch !== securityData.sessionEpoch;
    if (!epochChanged) continue;
    const principal = principalPuts.find(
      (operation) =>
        (operation.record.data as Readonly<Record<string, unknown>>).id ===
        securityData.principalId,
    );
    const fence = fencePuts.find(
      (operation) =>
        (operation.record.data as Readonly<Record<string, unknown>>).principalId ===
        securityData.principalId,
    );
    const principalData = principal?.record.data as Readonly<Record<string, unknown>> | undefined;
    const fenceData = fence?.record.data as Readonly<Record<string, unknown>> | undefined;
    const principalStatus = principalData?.status ?? fenceData?.principalStatus;
    if (
      !fence ||
      fenceData?.sessionEpoch !== securityData.sessionEpoch ||
      fenceData?.principalStatus !== principalStatus
    ) {
      return databaseFailure(
        "transact-write",
        "control",
        "Session epoch changes require a matching BFF revocation fence put.",
      );
    }
  }
  return undefined;
}
