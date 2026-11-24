import { Effect } from "effect";
import type { DatabaseError, TransactionOperation } from "../client-types.ts";
import { UNIQUE_CLAIM_CONDITION } from "../keys.ts";
import { tableForItemType, type PlatformRecord } from "../records/index.ts";
import { databaseFailure } from "../transaction-conditions.ts";
import {
  acquireUniqueClaim,
  makeUniqueClaimRecord,
  releaseUniqueClaim,
  type UniqueClaimRequirement,
} from "../unique-claims.ts";
import {
  capacityClaimRequirements,
  capacityHolding,
  isCapacityHolderItemType,
} from "./requirements.ts";

type UniqueClaimRecord = Extract<PlatformRecord, { readonly itemType: "unique-claim" }>;

const claimIdentity = (claim: { readonly namespace: string; readonly value: string }) =>
  `${claim.namespace}\u0000${claim.value}`;

function claimRecord(requirement: UniqueClaimRequirement, createdAt: string) {
  return makeUniqueClaimRecord(requirement, createdAt) as UniqueClaimRecord;
}

export function withCapacityClaims(
  operations: readonly TransactionOperation[],
): readonly TransactionOperation[] {
  const supplied = new Set(
    operations.flatMap((operation) =>
      operation.kind !== "condition-check" && operation.record.itemType === "unique-claim"
        ? [claimIdentity(operation.record.data)]
        : [],
    ),
  );
  const companions: TransactionOperation[] = [];
  for (const operation of operations) {
    if (operation.kind === "condition-check") continue;
    const previousRecord =
      operation.kind === "delete" ? operation.record : operation.previousRecord;
    const previous = previousRecord ? capacityClaimRequirements(previousRecord) : [];
    const next = operation.kind === "put" ? capacityClaimRequirements(operation.record) : [];
    const nextIdentities = new Set(next.map(claimIdentity));
    const previousIdentities = new Set(previous.map(claimIdentity));
    const createdAt = capacityHolding(operation.record)?.updatedAt;
    for (const requirement of next) {
      const identity = claimIdentity(requirement);
      if (previousIdentities.has(identity) || supplied.has(identity) || !createdAt) continue;
      supplied.add(identity);
      companions.push(acquireUniqueClaim(claimRecord(requirement, createdAt)));
    }
    for (const requirement of previous) {
      const identity = claimIdentity(requirement);
      if (nextIdentities.has(identity) || supplied.has(identity) || !previousRecord) continue;
      supplied.add(identity);
      companions.push(
        releaseUniqueClaim(
          claimRecord(requirement, capacityHolding(previousRecord)?.updatedAt ?? requirement.value),
        ),
      );
    }
  }
  return companions.length === 0 ? operations : [...operations, ...companions];
}

export function rejectUnslottedCapacityHolders(
  operations: readonly TransactionOperation[],
): Effect.Effect<readonly TransactionOperation[], DatabaseError> {
  for (const operation of operations) {
    if (operation.kind !== "put") continue;
    const holding = capacityHolding(operation.record);
    if (holding && holding.slot === undefined) {
      return Effect.fail(
        databaseFailure(
          "transact-write",
          "control",
          `${operation.record.itemType}:${holding.ownerId} holds ${holding.resource} capacity without a slot.`,
        ),
      );
    }
  }
  return Effect.succeed(operations);
}

export function capacityHolderDirectPutFailure(
  record: PlatformRecord,
  conditionExpression: string | undefined,
) {
  if (!isCapacityHolderItemType(record.itemType)) return undefined;
  const holding = capacityHolding(record);
  if (holding) {
    return databaseFailure(
      "put",
      tableForItemType(record.itemType),
      `${record.itemType}:${holding.ownerId} holds ${holding.resource} capacity and must be written in a transaction.`,
    );
  }
  const condition = conditionExpression?.trim();
  if (
    condition === undefined ||
    condition === UNIQUE_CLAIM_CONDITION ||
    condition === "attribute_not_exists(pk)" ||
    condition === "attribute_not_exists(sk)"
  ) {
    return undefined;
  }
  return databaseFailure(
    "put",
    tableForItemType(record.itemType),
    `${record.itemType} updates must be transactional with previousRecord so capacity claims are released.`,
  );
}
