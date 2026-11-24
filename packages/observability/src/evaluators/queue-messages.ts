import { Schema } from "effect";

const Id = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9]{16,64}$/u, { message: "Queue identifiers must be alphanumeric." }),
);

const scopeFields = {
  environmentId: Id,
  organizationId: Id,
  projectId: Id,
} as const;

/** Messages on the FIFO evaluation queue (queue-level delay provides polling back-off). */
export const EvaluationQueueMessage = Schema.Union([
  Schema.Struct({
    ...scopeFields,
    evaluationRunId: Id,
    type: Schema.Literal("evaluation-run.start"),
  }),
  Schema.Struct({
    ...scopeFields,
    evaluationRunId: Id,
    /** Distinguishes reconcile requests for FIFO deduplication (e.g. the finished case key). */
    trigger: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9-]{1,80}$/u)),
    type: Schema.Literal("evaluation-run.reconcile"),
  }),
  Schema.Struct({
    ...scopeFields,
    attempt: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
    caseKey: Id,
    evaluationRunId: Id,
    type: Schema.Literal("evaluation-case.advance"),
  }),
  Schema.Struct({
    ...scopeFields,
    releaseComparisonId: Id,
    trigger: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9-]{1,80}$/u)),
    type: Schema.Literal("release-comparison.reconcile"),
  }),
  Schema.Struct({
    ...scopeFields,
    traceId: Id,
    type: Schema.Literal("trace.score"),
  }),
]);
export type EvaluationQueueMessage = typeof EvaluationQueueMessage.Type;

export interface EvaluationQueueEnvelope {
  readonly body: string;
  readonly deduplicationId: string;
  readonly groupId: string;
}

/**
 * FIFO routing: run-level messages share one group per evaluation run so run mutations are
 * serialized; each case polls in its own group; deduplication IDs make producer retries safe.
 */
export function evaluationQueueEnvelope(message: EvaluationQueueMessage): EvaluationQueueEnvelope {
  const body = JSON.stringify(Schema.decodeUnknownSync(EvaluationQueueMessage)(message));
  switch (message.type) {
    case "evaluation-run.start":
      return {
        body,
        deduplicationId: `start-${message.evaluationRunId}`,
        groupId: `run-${message.evaluationRunId}`,
      };
    case "evaluation-run.reconcile":
      return {
        body,
        deduplicationId: `reconcile-${message.evaluationRunId}-${message.trigger}`,
        groupId: `run-${message.evaluationRunId}`,
      };
    case "evaluation-case.advance":
      return {
        body,
        deduplicationId: `advance-${message.evaluationRunId}-${message.caseKey}-${message.attempt}`,
        groupId: `case-${message.evaluationRunId}-${message.caseKey}`,
      };
    case "release-comparison.reconcile":
      return {
        body,
        deduplicationId: `comparison-${message.releaseComparisonId}-${message.trigger}`,
        groupId: `comparison-${message.releaseComparisonId}`,
      };
    case "trace.score":
      return {
        body,
        deduplicationId: `score-${message.traceId}`,
        groupId: `trace-${message.traceId}`,
      };
  }
}

export function parseEvaluationQueueMessage(body: string): EvaluationQueueMessage {
  return Schema.decodeUnknownSync(EvaluationQueueMessage)(JSON.parse(body));
}
