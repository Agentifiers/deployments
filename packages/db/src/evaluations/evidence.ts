import type { DynamoDatabaseService } from "../client-types.ts";
import { key } from "../keys.ts";
import type { PlatformRecord } from "../records/index.ts";
import {
  inEvaluationScope,
  queryScopedPage,
  readScopedRecord,
  runDatabase,
  type EvaluationScope,
} from "./support.ts";

type RecordOf<ItemType extends PlatformRecord["itemType"]> = Extract<
  PlatformRecord,
  { readonly itemType: ItemType }
>;

export type EvaluationRunEvidenceRecord = RecordOf<"run">;
export type EvaluationMessageEvidenceRecord = RecordOf<"message">;
export type EvaluationToolCallEvidenceRecord = RecordOf<"tool-call">;
export type EvaluationTraceEvidenceRecord = RecordOf<"trace">;

/**
 * Bounds for one run's evidence reads. `MAX_EVALUATION_RUN_MESSAGES` caps the thread messages
 * scanned from the run's user message, including queued turns interleaved with the run's own.
 */
export const MAX_EVALUATION_RUN_MESSAGES = 500;
export const MAX_EVALUATION_RUN_TOOL_CALLS = 500;
export const MAX_EVALUATION_TRACE_RUNS = 50;

/**
 * Read-only access to the canonical run, message, tool-call, and trace records that scorers
 * evaluate, plus the agent resources an evaluation targets.
 */
export interface EvaluationEvidencePersistence {
  readonly getRun: (
    threadId: string,
    runId: string,
  ) => Promise<EvaluationRunEvidenceRecord | undefined>;
  readonly locateRun: (runId: string) => Promise<EvaluationRunEvidenceRecord | undefined>;
  /**
   * The run's own messages in sequence order: its user message and every message it wrote.
   * Empty when the run's messages cannot be located within the evidence bounds, which scorers
   * record as missing evidence.
   */
  readonly listRunMessages: (
    run: EvaluationRunEvidenceRecord,
  ) => Promise<readonly EvaluationMessageEvidenceRecord[]>;
  /** The run's tool calls; `undefined` when they exceed `MAX_EVALUATION_RUN_TOOL_CALLS`. */
  readonly listRunToolCalls: (
    runId: string,
  ) => Promise<readonly EvaluationToolCallEvidenceRecord[] | undefined>;
  readonly getTrace: (traceId: string) => Promise<EvaluationTraceEvidenceRecord | undefined>;
  readonly getThread: (threadId: string) => Promise<RecordOf<"thread"> | undefined>;
  readonly getAgentRelease: (id: string) => Promise<RecordOf<"agent-release"> | undefined>;
  readonly getAgentDeployment: (id: string) => Promise<RecordOf<"agent-deployment"> | undefined>;
}

export function makeEvaluationEvidencePersistence(
  database: DynamoDatabaseService,
  scope: EvaluationScope,
): EvaluationEvidencePersistence {
  const threadPartition = (threadId: string) =>
    key("ORG", scope.organizationId, "THREAD", threadId);
  const environmentPartition = key("ORG", scope.organizationId, "ENV", scope.environmentId);

  return {
    async getRun(threadId, runId) {
      const lookup = await readScopedRecord(
        database,
        scope,
        "execution",
        { pk: threadPartition(threadId), sk: key("RUN-LOOKUP", runId) },
        "run-lookup",
      );
      if (!lookup || lookup.data.runId !== runId) return undefined;
      const run = await readScopedRecord(
        database,
        scope,
        "execution",
        { pk: threadPartition(threadId), sk: key("RUN", lookup.data.idempotencyKey) },
        "run",
      );
      return run?.data.id === runId ? run : undefined;
    },

    async locateRun(runId) {
      const locator = await readScopedRecord(
        database,
        scope,
        "control",
        { pk: environmentPartition, sk: key("RUN-LOCATOR", runId) },
        "run-locator",
      );
      if (!locator) return undefined;
      const run = await readScopedRecord(
        database,
        scope,
        "execution",
        { pk: locator.data.runPk, sk: locator.data.runSk },
        "run",
      );
      return run?.data.id === runId ? run : undefined;
    },

    /*
     * Messages are keyed only by thread sequence, so a run is located from its user message
     * sequence. Runs on a thread execute in FIFO order: once a turn queued after this run has
     * written output, this run has finished and the rest of the thread is never read. Earlier
     * runs' output interleaved after the user message is skipped.
     */
    async listRunMessages(run) {
      const fromSequence = run.data.userMessageSequence;
      if (fromSequence === undefined) return [];
      const messages: EvaluationMessageEvidenceRecord[] = [];
      const laterRunIds = new Set<string>();
      let scanned = 0;
      let exclusiveStartKey: Readonly<Record<string, unknown>> | undefined;
      do {
        const result = await runDatabase(
          "evaluation message read",
          database.queryRecords("execution", {
            ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
            ConsistentRead: true,
            ExpressionAttributeValues: {
              ":lower": key("MESSAGE", String(fromSequence).padStart(16, "0")),
              ":pk": threadPartition(run.data.threadId),
              ":upper": key("MESSAGE", "~"),
            },
            KeyConditionExpression: "pk = :pk AND sk BETWEEN :lower AND :upper",
            // One message past the bound distinguishes a full window from an overflow.
            Limit: Math.min(100, MAX_EVALUATION_RUN_MESSAGES + 1 - scanned),
            ScanIndexForward: true,
          }),
        );
        for (const record of result.items) {
          scanned += 1;
          if (
            record.itemType !== "message" ||
            !inEvaluationScope(scope, record.data as Readonly<Record<string, unknown>>)
          ) {
            continue;
          }
          const { id, role, runId } = record.data;
          if (runId === run.data.id || id === run.data.userMessageId) messages.push(record);
          else if (runId === undefined) continue;
          else if (role === "user") laterRunIds.add(runId);
          else if (laterRunIds.has(runId)) return messages;
        }
        exclusiveStartKey = result.lastEvaluatedKey;
      } while (exclusiveStartKey && scanned <= MAX_EVALUATION_RUN_MESSAGES);
      return scanned > MAX_EVALUATION_RUN_MESSAGES ? [] : messages;
    },

    async listRunToolCalls(runId) {
      const calls: EvaluationToolCallEvidenceRecord[] = [];
      let cursor: string | undefined;
      do {
        const page = await queryScopedPage(database, scope, {
          itemType: "tool-call",
          options: {
            ...(cursor ? { cursor } : {}),
            limit: Math.min(100, MAX_EVALUATION_RUN_TOOL_CALLS + 1 - calls.length),
          },
          partition: key("ORG", scope.organizationId, "RUN", runId),
          prefix: "TOOL-CALL#",
          table: "execution",
        });
        calls.push(...page.items);
        if (calls.length > MAX_EVALUATION_RUN_TOOL_CALLS) return undefined;
        cursor = page.nextCursor;
      } while (cursor);
      return calls;
    },

    getTrace: (traceId) =>
      readScopedRecord(
        database,
        scope,
        "execution",
        { pk: key("ORG", scope.organizationId, "TRACE", traceId), sk: key("TRACE", traceId) },
        "trace",
      ),

    getThread: (threadId) =>
      readScopedRecord(
        database,
        scope,
        "execution",
        { pk: threadPartition(threadId), sk: key("THREAD", threadId) },
        "thread",
      ),

    getAgentRelease: (id) =>
      readScopedRecord(
        database,
        scope,
        "control",
        { pk: environmentPartition, sk: key("AGENT-RELEASE", id) },
        "agent-release",
      ),

    getAgentDeployment: (id) =>
      readScopedRecord(
        database,
        scope,
        "control",
        { pk: environmentPartition, sk: key("AGENT-DEPLOYMENT", id) },
        "agent-deployment",
      ),
  };
}
