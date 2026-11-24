import type { TransactionOperation } from "../client-types.ts";
import type { PlatformRecord } from "../records/index.ts";
import {
  acquireUniqueClaim,
  makeUniqueClaimRecord,
  releaseUniqueClaim,
  uniqueClaimRequirements,
  type UniqueClaimRequirement,
} from "../unique-claims.ts";

function claimRecord(requirement: UniqueClaimRequirement, timestamp: string) {
  return makeUniqueClaimRecord(requirement, timestamp) as Extract<
    PlatformRecord,
    { readonly itemType: "unique-claim" }
  >;
}

function sameClaim(left: UniqueClaimRequirement, right: UniqueClaimRequirement) {
  return left.namespace === right.namespace && left.value === right.value;
}

export function createBrainRecordOperations(
  record: PlatformRecord,
  timestamp: string,
): TransactionOperation[] {
  return [
    { kind: "put", record },
    ...uniqueClaimRequirements(record).map((requirement) =>
      acquireUniqueClaim(claimRecord(requirement, timestamp)),
    ),
  ];
}

export function updateBrainRecordOperations(
  previous: PlatformRecord,
  next: PlatformRecord,
  timestamp: string,
): TransactionOperation[] {
  const previousClaims = uniqueClaimRequirements(previous);
  const nextClaims = uniqueClaimRequirements(next);
  const operations: TransactionOperation[] = [
    { kind: "put", previousRecord: previous, record: next },
  ];
  for (const requirement of nextClaims) {
    if (!previousClaims.some((candidate) => sameClaim(candidate, requirement))) {
      operations.push(acquireUniqueClaim(claimRecord(requirement, timestamp)));
    }
  }
  for (const requirement of previousClaims) {
    if (!nextClaims.some((candidate) => sameClaim(candidate, requirement))) {
      const createdAt = (previous.data as Readonly<Record<string, unknown>>).createdAt;
      if (typeof createdAt !== "string") {
        throw new TypeError("Unique-claim owner has no creation timestamp.");
      }
      operations.push(releaseUniqueClaim(claimRecord(requirement, createdAt)));
    }
  }
  return operations;
}
