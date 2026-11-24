import {
  governanceObjectDigest,
  expiresByRetentionTtl,
  RETENTION_TTL_GRACE_SECONDS,
  type TenantRecordLocator,
  type TenantRecordSelection,
} from "@deployments-ai/db";
import { retentionMinimumAgeMilliseconds } from "./governance-record-classification.ts";
import { BLOB_REFERENCE_FIELDS } from "./governance-service-support.ts";
import type { RetentionCleanup, RetentionPolicy } from "./types.ts";

// Read in full, strongly, on every run: the active work that keeps other records from expiring,
// the email companions staged with their parents, and pending cleanups. A stale or missing copy
// of any of these could expire protected work or skip a companion.
const RETENTION_CONTEXT_ITEM_TYPES: Readonly<Record<string, true>> = {
  "inbox-draft": true,
  "inbox-draft-created-index": true,
  "inbox-message": true,
  "inbox-message-created-index": true,
  "inbox-message-thread-alias": true,
  "inbox-message-thread-index": true,
  "inbox-resource-locator": true,
  "inbox-thread-created-index": true,
  "message-publication": true,
  "retention-cleanup": true,
  run: true,
  trace: true,
  "workflow-execution": true,
};

// Item types whose records can keep a blob alive (`blobReferences`). Retention cleanups are not
// holders: their references are what the cleanup deletes.
const OBJECT_HOLDER_ITEM_TYPES = new Set<string>([
  ...Object.keys(BLOB_REFERENCE_FIELDS),
  "inbox-content-cleanup",
]);

function locatorRecordKey(locator: TenantRecordLocator) {
  return `${locator.recordTable}\u0000${locator.recordPk}\u0000${locator.recordSk}`;
}

/**
 * Plans one retention run's inventory reads from the strongly read locators instead of every
 * canonical record.
 *
 * `selection` resolves the context types strongly and every other record only when its locator
 * timestamp is old enough to be due under the policy (or the locator predates timestamps). Those
 * candidates are read eventually consistently: retention deletes a candidate only through a
 * transaction conditioned on the version or timestamp it read, so a stale copy makes that
 * delete fail and the record is retried on the next run, never deleted on stale data.
 *
 * While selecting, it indexes which locators name which objects so `liveObjectHolders` can
 * strongly re-read just the records that may still reference an object a cleanup deletes.
 */
export function makeRetentionInventory(
  policy: RetentionPolicy | "cleanup-only",
  startedAtMilliseconds: number,
) {
  const holdersByDigest = new Map<string, string[]>();
  const unindexedHolders: string[] = [];
  const selection: TenantRecordSelection = {
    select(locator) {
      if (locator.recordItemType !== "retention-cleanup") {
        const recordKey = locatorRecordKey(locator);
        if (locator.recordObjectDigests === undefined) {
          if (OBJECT_HOLDER_ITEM_TYPES.has(locator.recordItemType)) {
            unindexedHolders.push(recordKey);
          }
        } else {
          for (const digest of locator.recordObjectDigests) {
            const holders = holdersByDigest.get(digest);
            if (holders) holders.push(recordKey);
            else holdersByDigest.set(digest, [recordKey]);
          }
        }
      }
      if (policy === "cleanup-only") return undefined;
      if (RETENTION_CONTEXT_ITEM_TYPES[locator.recordItemType]) return "consistent";
      const minimumAge = retentionMinimumAgeMilliseconds(locator.recordItemType, policy);
      if (minimumAge === undefined) return undefined;
      // A locator without a parseable timestamp cannot rule its record out.
      const timestamp =
        locator.recordTimestamp === undefined ? Number.NaN : Date.parse(locator.recordTimestamp);
      if (Number.isNaN(timestamp)) return "eventual";
      const deadline = timestamp + minimumAge;
      // DynamoDB TTL removes the record for free by its ttl, at most the grace past its deadline;
      // retention deletes it only when the policy has since shortened past that ttl.
      if (
        expiresByRetentionTtl(locator.recordItemType) &&
        locator.recordTtl !== undefined &&
        locator.recordTtl <= Math.floor(deadline / 1_000) + RETENTION_TTL_GRACE_SECONDS
      ) {
        return undefined;
      }
      return deadline <= startedAtMilliseconds ? "eventual" : undefined;
    },
  };
  return {
    /**
     * A strong selection of the records, other than the staged ones, whose locators name an
     * object the pending cleanups reference, or `undefined` when no such record can exist.
     */
    liveObjectHolders(
      cleanups: readonly RetentionCleanup[],
      stagedRecordKeys: ReadonlySet<string>,
    ): TenantRecordSelection | undefined {
      const holders = new Set<string>();
      let referencesObjects = false;
      for (const cleanup of cleanups) {
        // completeRetentionCleanups leaves a cleanup alone until its notBefore.
        if (cleanup.notBefore && Date.parse(cleanup.notBefore) > startedAtMilliseconds) continue;
        for (const reference of cleanup.references) {
          referencesObjects = true;
          const digest = governanceObjectDigest(reference.bucket, reference.key);
          for (const recordKey of holdersByDigest.get(digest) ?? []) holders.add(recordKey);
        }
      }
      if (!referencesObjects) return undefined;
      for (const recordKey of unindexedHolders) holders.add(recordKey);
      for (const recordKey of stagedRecordKeys) holders.delete(recordKey);
      if (holders.size === 0) return undefined;
      return {
        select: (locator) => (holders.has(locatorRecordKey(locator)) ? "consistent" : undefined),
      };
    },
    selection,
  };
}
