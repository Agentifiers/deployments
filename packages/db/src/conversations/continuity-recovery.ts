import type { DynamoDatabaseService } from "../client-types.ts";
import { key } from "../keys.ts";
import type { PlatformRecord } from "../records/index.ts";
import { readRecord } from "./consistent-record-read.ts";
import { makeConversationPersistence, type ConversationCheckpoint } from "./persistence.ts";

type Run = Extract<PlatformRecord, { readonly itemType: "run" }>;
type MessagePublication = Extract<PlatformRecord, { readonly itemType: "message-publication" }>;

export interface ConversationContinuityRecoveryCandidate {
  readonly publication?: MessagePublication;
  readonly run: Run;
}

export interface ConversationContinuityRecoveryScope {
  readonly environmentId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly threadId: string;
}

const MAX_RECOVERY_RUNS = 64;
const MAX_RECOVERY_MESSAGES = MAX_RECOVERY_RUNS * 2;

function scopeMatches(
  record: { readonly data: Record<string, unknown> },
  scope: ConversationContinuityRecoveryScope,
) {
  return (
    record.data.organizationId === scope.organizationId &&
    record.data.projectId === scope.projectId &&
    record.data.environmentId === scope.environmentId &&
    record.data.threadId === scope.threadId
  );
}

function tenantScopeMatches(
  record: { readonly data: Record<string, unknown> },
  scope: ConversationContinuityRecoveryScope,
) {
  return (
    record.data.organizationId === scope.organizationId &&
    record.data.projectId === scope.projectId &&
    record.data.environmentId === scope.environmentId
  );
}

function requiresSettledExternalPublication(run: Run) {
  return (
    run.data.trigger === "heartbeat" ||
    run.data.trigger === "schedule" ||
    run.data.responsePublication === "external"
  );
}

async function recoveryCandidate(
  database: DynamoDatabaseService,
  scope: ConversationContinuityRecoveryScope,
  runId: string,
): Promise<ConversationContinuityRecoveryCandidate | undefined> {
  const threadPk = key("ORG", scope.organizationId, "THREAD", scope.threadId);
  const lookup = await readRecord(database, "execution", {
    pk: threadPk,
    sk: key("RUN-LOOKUP", runId),
  });
  if (!lookup) return undefined;
  if (
    lookup.itemType !== "run-lookup" ||
    lookup.data.runId !== runId ||
    !scopeMatches(lookup, scope)
  ) {
    throw new Error("Conversation run lookup does not match its continuity recovery scope.");
  }
  const run = await readRecord(database, "execution", {
    pk: threadPk,
    sk: key("RUN", lookup.data.idempotencyKey),
  });
  if (
    !run ||
    run.itemType !== "run" ||
    run.data.id !== runId ||
    run.data.status !== "completed" ||
    run.data.userMessageId === undefined ||
    run.data.userMessageSequence === undefined ||
    !scopeMatches(run, scope)
  ) {
    return undefined;
  }
  const flush = await readRecord(database, "execution", {
    pk: key("ORG", scope.organizationId, "RUN", runId),
    sk: key("MEMORY-FLUSH", `memory-flush:${runId}`),
  });
  if (
    flush &&
    (flush.itemType !== "memory-flush" ||
      flush.data.runId !== runId ||
      !tenantScopeMatches(flush, scope))
  ) {
    throw new Error("Conversation memory flush key contains an unexpected record.");
  }
  if (flush && (flush.data.status === "queued" || flush.data.status === "running")) {
    return undefined;
  }
  if (flush?.data.status === "succeeded") return undefined;
  if (!requiresSettledExternalPublication(run)) return { run };
  const publication = await readRecord(database, "execution", {
    pk: threadPk,
    sk: key("MESSAGE-PUBLICATION", runId),
  });
  if (
    !publication ||
    publication.itemType !== "message-publication" ||
    (publication.data.status !== "published" && publication.data.status !== "released") ||
    publication.data.runId !== runId ||
    publication.data.agentDeploymentId !== run.data.agentDeploymentId ||
    !scopeMatches(publication, scope)
  ) {
    return undefined;
  }
  return { publication, run };
}

export function makeConversationContinuityRecoveryPersistence(database: DynamoDatabaseService) {
  return {
    async candidates(input: {
      readonly checkpoint?: ConversationCheckpoint;
      readonly limit?: number;
      readonly scope: ConversationContinuityRecoveryScope;
      readonly throughSequence: number;
    }): Promise<readonly ConversationContinuityRecoveryCandidate[]> {
      const limit = input.limit ?? MAX_RECOVERY_RUNS;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RECOVERY_RUNS) {
        throw new TypeError(`Continuity recovery limit must be from 1 to ${MAX_RECOVERY_RUNS}.`);
      }
      const afterSequence = input.checkpoint
        ? input.checkpoint.data.throughSequence -
          (input.checkpoint.data.throughMessageCharacterOffset === undefined ? 0 : 1)
        : undefined;
      const messages = await makeConversationPersistence(database).messagesInSequenceRange(
        {
          organizationId: input.scope.organizationId,
          threadId: input.scope.threadId,
        },
        {
          ...(afterSequence === undefined ? {} : { afterSequence }),
          limit: MAX_RECOVERY_MESSAGES,
          throughSequence: input.throughSequence,
        },
      );
      const runIds = [
        ...new Set(
          messages.flatMap((message) =>
            message.itemType === "message" && message.data.runId ? [message.data.runId] : [],
          ),
        ),
      ];
      const recovered = await Promise.all(
        runIds.map((runId) => recoveryCandidate(database, input.scope, runId)),
      );
      return recovered
        .filter((candidate): candidate is ConversationContinuityRecoveryCandidate => !!candidate)
        .toSorted(
          (left, right) =>
            left.run.data.userMessageSequence! - right.run.data.userMessageSequence! ||
            left.run.data.createdAt.localeCompare(right.run.data.createdAt) ||
            left.run.data.id.localeCompare(right.run.data.id),
        )
        .slice(0, limit);
    },
  };
}
