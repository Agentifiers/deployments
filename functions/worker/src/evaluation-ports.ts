import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type {
  AdmitModelId,
  BlobReference,
  DynamoDatabaseService,
  EvaluationMessageEvidenceRecord,
  EvaluationPersistence,
  EvaluationScope,
  Ulid,
} from "@deployments-ai/db";
import {
  evaluationQueueEnvelope,
  type EvaluationQueueMessage,
  type JudgeModelPort,
} from "@deployments-ai/observability/evaluators";

export type EvaluationBlobReference = typeof BlobReference.Type;

export interface CreateEvaluationBindingInput {
  readonly scope: EvaluationScope;
  readonly purpose: "evaluation";
  readonly source: { readonly type: "release"; readonly agentReleaseId: string };
  readonly runtimeConfigFromAgentDeploymentId?: string;
  readonly toolPolicy: "evaluation";
  readonly createdBy: { readonly id: string; readonly type: "principal" };
  readonly ttlSeconds: number;
  readonly idempotencyKey: string;
}

export interface SubmitEvaluationTurnInput {
  readonly scope: EvaluationScope;
  readonly executionBindingId: string;
  readonly content: string;
  readonly idempotencyKey: string;
  readonly actor: { readonly id: string; readonly type: "principal" };
  readonly title: string;
}

export interface SubmittedEvaluationTurn {
  readonly runId: string;
  readonly threadId: string;
  readonly runIdempotencyKey: string;
  readonly traceId: string;
}

/** Ephemeral execution of a release under test; implemented over the execution-binding runtime. */
export interface EvaluationExecutionPort {
  /**
   * Throws `EvaluationTerminalError` with a specific code (for example a model admission reason)
   * when the binding is rejected for a reason the run should report instead of the generic
   * `execution_binding_failed`.
   */
  readonly createBinding: (
    input: CreateEvaluationBindingInput,
  ) => Promise<{ readonly executionBindingId: string }>;
  /**
   * Throws `EvaluationTerminalError` when the turn is rejected permanently (for example blank
   * content or an expired binding), so the case fails instead of being redelivered.
   */
  readonly submitTurn: (input: SubmitEvaluationTurnInput) => Promise<SubmittedEvaluationTurn>;
}

export interface EvaluationArtifactReader {
  /** Reads a dataset case material object, bounded by its reference size. */
  readonly readCaseMaterial: (reference: EvaluationBlobReference) => Promise<Uint8Array>;
  /** Reads an externally stored message body (bounded). */
  readonly readMessageBody: (message: EvaluationMessageEvidenceRecord) => Promise<string>;
}

export interface EvaluationArtifactWriter {
  /** Stores an immutable report object (SSE-KMS, versioned bucket). */
  readonly putReport: (input: {
    readonly key: string;
    readonly body: string;
    readonly contentType: string;
  }) => Promise<EvaluationBlobReference>;
}

export interface EvaluationQueueSender {
  readonly send: (message: EvaluationQueueMessage) => Promise<void>;
}

/** The evaluated environment; judge tokens carry it so its policy and grants admit the model. */
export interface EvaluationJudgeTenant {
  readonly environmentId: string;
  readonly organizationId: string;
  readonly projectId: string;
}

export interface EvaluationJudgeContext extends EvaluationJudgeTenant {
  /** The evaluated run; judge usage is computed against it but never metered to it. */
  readonly runId: string;
  readonly traceId: string;
  readonly scoreDefinitionId: string;
  readonly revision: number;
}

export interface EvaluationWorkerDependencies {
  /** Admits a judge model against the environment's current model policy, catalog, and grants. */
  readonly admitJudgeModel: AdmitModelId;
  readonly database: DynamoDatabaseService;
  readonly execution: EvaluationExecutionPort;
  readonly artifacts: EvaluationArtifactReader & EvaluationArtifactWriter;
  readonly queue: EvaluationQueueSender;
  /** Judge model access for one score; never creates runs, traces, or customer meter events. */
  readonly judgeFor: (context: EvaluationJudgeContext) => JudgeModelPort;
  readonly generateId: () => Promise<Ulid>;
  readonly now: () => Date;
}

/** Dependencies bound to the environment scope of one queue message. */
export interface EvaluationMessageContext extends EvaluationWorkerDependencies {
  readonly scope: EvaluationScope;
  readonly persistence: EvaluationPersistence;
}

/** FIFO sender for evaluation queue messages (group and deduplication IDs from the envelope). */
export function createSqsEvaluationQueueSender(options: {
  readonly queueUrl: string;
  readonly client?: Pick<SQSClient, "send">;
}): EvaluationQueueSender {
  const client = options.client ?? new SQSClient({});
  return {
    async send(message) {
      const envelope = evaluationQueueEnvelope(message);
      await client.send(
        new SendMessageCommand({
          MessageBody: envelope.body,
          MessageDeduplicationId: envelope.deduplicationId,
          MessageGroupId: envelope.groupId,
          QueueUrl: options.queueUrl,
        }),
      );
    },
  };
}
