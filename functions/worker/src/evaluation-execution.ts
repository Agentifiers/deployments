import {
  ConversationError,
  createEphemeralTurnService,
  ExecutionBindingManifestNotAdmittedError,
} from "@deployments-ai/conversations";
import {
  makeIdGenerator,
  type AdmitManifest,
  type DynamoDatabaseService,
  type Ulid,
} from "@deployments-ai/db";
import type { EvaluationExecutionPort } from "./evaluation-ports.ts";
import { EvaluationTerminalError } from "./evaluation-run-lifecycle.ts";
import { createSqsAgentRunQueueEnqueue } from "./sqs.ts";

/**
 * Conversation submission failures that can succeed on redelivery of the same idempotent turn:
 * a concurrent claim on the idempotency key, a lost thread write race, or an unavailable
 * acceptance stream after the durable commit. Every other conversation error (invalid or
 * oversized content, expired binding, missing or out-of-scope records, idempotency conflicts)
 * rejects the turn permanently.
 */
const TRANSIENT_SUBMIT_ERROR_CODES: Readonly<Record<string, true>> = {
  idempotency_in_progress: true,
  stream_unavailable: true,
  write_conflict: true,
  write_failed: true,
};

/**
 * Runs evaluation cases through evaluation execution bindings: the release under test executes
 * on the normal agent-run queue with the evaluation tool policy, isolated from customer
 * deployments, listings, and channel delivery.
 */
export function makeEvaluationExecutionPort(options: {
  readonly admitManifest: AdmitManifest;
  readonly agentRunQueueUrl: string;
  readonly database: DynamoDatabaseService;
}): EvaluationExecutionPort {
  const ids = makeIdGenerator();
  const service = createEphemeralTurnService({
    admitManifest: options.admitManifest,
    database: options.database,
    enqueueRun: createSqsAgentRunQueueEnqueue({ queueUrl: options.agentRunQueueUrl }),
    generateId: async () => ids.generate(),
  });
  return {
    async createBinding(input) {
      try {
        const { binding } = await service.createExecutionBinding({
          ...input.scope,
          createdBy: { id: input.createdBy.id as Ulid, type: input.createdBy.type },
          idempotencyKey: input.idempotencyKey,
          purpose: input.purpose,
          ...(input.runtimeConfigFromAgentDeploymentId
            ? {
                runtimeConfigFromAgentDeploymentId:
                  input.runtimeConfigFromAgentDeploymentId as Ulid,
              }
            : {}),
          source: { agentReleaseId: input.source.agentReleaseId as Ulid, type: "release" },
          toolPolicy: input.toolPolicy,
          ttlSeconds: input.ttlSeconds,
        });
        return { executionBindingId: binding.data.id };
      } catch (cause) {
        // The release references a model or tool its environment no longer admits: fail the
        // evaluation run with the admission reason instead of the generic binding failure.
        if (cause instanceof ExecutionBindingManifestNotAdmittedError) {
          throw new EvaluationTerminalError(cause.code, cause.message);
        }
        throw cause;
      }
    },
    async submitTurn(input) {
      try {
        const result = await service.submitEphemeralTurn({
          ...input.scope,
          actor: { id: input.actor.id as Ulid, type: input.actor.type },
          content: input.content,
          executionBindingId: input.executionBindingId as Ulid,
          idempotencyKey: input.idempotencyKey,
          title: input.title,
        });
        return {
          runId: result.run.data.id,
          runIdempotencyKey: result.run.data.idempotencyKey,
          threadId: result.thread.data.id,
          traceId: result.run.data.traceId,
        };
      } catch (cause) {
        if (
          cause instanceof ConversationError &&
          !Object.hasOwn(TRANSIENT_SUBMIT_ERROR_CODES, cause.code)
        ) {
          throw new EvaluationTerminalError(cause.code, cause.message);
        }
        throw cause;
      }
    },
  };
}
