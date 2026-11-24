import type { TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { DatabaseError, type TransactionOperation } from "../client-types.ts";
import { UNIQUE_CLAIM_CONDITION } from "../keys.ts";
import { withCanonicalRecordKeys, type PlatformRecord } from "../records/index.ts";
import { endUserErasureFenceKey, threadTombstoneKey } from "./record-keys.ts";
import { fencedThreadIds } from "./ownership.ts";

type EndUserThreadRecord = Extract<PlatformRecord, { readonly itemType: "end-user-thread" }>;

export class ThreadErasedError extends DatabaseError {
  readonly threadIds: readonly string[];

  constructor(threadIds: readonly string[], cause: unknown) {
    super({
      cause,
      message: `Thread ${threadIds.join(", ")} has been erased.`,
      operation: "transact-write",
      reason: "unknown",
      table: "execution",
    });
    this.threadIds = threadIds;
  }
}

export class EndUserErasureInProgressError extends DatabaseError {
  constructor(cause: unknown) {
    super({
      cause,
      message: "An erasure of this end user is in progress.",
      operation: "transact-write",
      reason: "unknown",
      table: "control",
    });
  }
}

function targetKey(operation: TransactionOperation) {
  return operation.kind === "condition-check"
    ? `${operation.key.pk}\u0000${operation.key.sk}`
    : `${operation.record.pk}\u0000${operation.record.sk}`;
}

export function withThreadErasureFences(
  operations: readonly TransactionOperation[],
): readonly TransactionOperation[] {
  const targeted = new Set(operations.map(targetKey));
  const checks = new Map<string, TransactionOperation>();
  for (const operation of operations) {
    if (operation.kind !== "put") continue;
    for (const record of [operation.record, operation.previousRecord]) {
      if (!record) continue;
      const organizationId = (record.data as Readonly<Record<string, unknown>>).organizationId;
      if (typeof organizationId !== "string") continue;
      for (const threadId of fencedThreadIds(record)) {
        const key = threadTombstoneKey(organizationId, threadId);
        const target = `${key.pk}\u0000${key.sk}`;
        if (targeted.has(target) || checks.has(target)) continue;
        checks.set(target, {
          conditionExpression: "attribute_not_exists(pk)",
          key,
          kind: "condition-check",
          table: "execution",
        });
      }
    }
  }
  return checks.size === 0 ? operations : [...operations, ...checks.values()];
}

export function withEndUserThreadIndex(
  operations: readonly TransactionOperation[],
): readonly TransactionOperation[] {
  return operations.flatMap((operation): TransactionOperation[] => {
    if (
      operation.kind !== "put" ||
      operation.previousRecord ||
      operation.record.itemType !== "thread" ||
      !operation.record.data.endUserKey
    ) {
      return [operation];
    }
    const thread = operation.record.data;
    const endUserKey = thread.endUserKey!;
    const index = withCanonicalRecordKeys({
      data: {
        createdAt: thread.createdAt,
        endUserKey,
        environmentId: thread.environmentId,
        organizationId: thread.organizationId,
        projectId: thread.projectId,
        threadId: thread.id,
      },
      itemType: "end-user-thread" as const,
    }) as EndUserThreadRecord;
    return [
      operation,
      { conditionExpression: UNIQUE_CLAIM_CONDITION, kind: "put", record: index },
      {
        conditionExpression: "attribute_not_exists(pk)",
        key: endUserErasureFenceKey(thread.organizationId, thread.environmentId, endUserKey),
        kind: "condition-check",
        table: "control",
      },
    ];
  });
}

function cancellationCodes(cause: unknown): readonly (string | undefined)[] {
  if (!cause || typeof cause !== "object") return [];
  const candidate = cause as Readonly<Record<string, unknown>>;
  const reasons = candidate.CancellationReasons ?? candidate.cancellationReasons;
  if (!Array.isArray(reasons)) return [];
  return reasons.map((reason: unknown) => {
    if (!reason || typeof reason !== "object") return undefined;
    const code = (reason as Readonly<Record<string, unknown>>).Code;
    return typeof code === "string" ? code : undefined;
  });
}

export class InboxMailErasedError extends DatabaseError {
  constructor(cause: unknown) {
    super({
      cause,
      message: "The inbox mail this write names has been erased.",
      operation: "transact-write",
      reason: "unknown",
      table: "execution",
    });
  }
}

export function erasureFenceFailure(
  input: TransactWriteCommandInput,
  cause: unknown,
): ThreadErasedError | EndUserErasureInProgressError | InboxMailErasedError | undefined {
  const items = input.TransactItems ?? [];
  const erasedThreadIds: string[] = [];
  let endUserFenced = false;
  let mailErased = false;
  for (const [index, code] of cancellationCodes(cause).entries()) {
    if (code !== "ConditionalCheckFailed") continue;
    const key = items[index]?.ConditionCheck?.Key;
    if (!key) continue;
    const [, , scope, encodedThreadId] = String(key.pk).split("#");
    if (key.sk === "TOMBSTONE" && scope === "THREAD" && encodedThreadId) {
      erasedThreadIds.push(decodeURIComponent(encodedThreadId));
    } else if (key.sk === "END-USER-ERASURE-FENCE") {
      endUserFenced = true;
    } else if (key.sk === "INBOX-MESSAGE-TOMBSTONE" || key.sk === "INBOX-THREAD-ERASURE-FENCE") {
      mailErased = true;
    }
  }
  if (erasedThreadIds.length > 0) return new ThreadErasedError(erasedThreadIds.sort(), cause);
  if (mailErased) return new InboxMailErasedError(cause);
  return endUserFenced ? new EndUserErasureInProgressError(cause) : undefined;
}
