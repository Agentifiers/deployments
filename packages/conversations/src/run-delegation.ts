import {
  MAX_RUN_DELEGATION_ANCESTORS,
  RunDelegationRecord,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
} from "@deployments-ai/db";
import { Schema } from "effect";
import {
  ConversationError,
  record,
  type ConversationRun,
  type SubmitConversationTurnInput,
} from "./submission.ts";

export type ConversationRunDelegation = Extract<
  PlatformRecord,
  { readonly itemType: "run-delegation" }
>;

/** Loads the delegation link of the parent run, when the parent is itself a delegated child. */
export async function loadParentRunDelegation(
  database: DynamoDatabaseService,
  input: SubmitConversationTurnInput,
): Promise<ConversationRunDelegation | undefined> {
  const context = input.traceContext;
  if (!context) return undefined;
  const value = await record(database, {
    childRunId: context.parentRunId,
    kind: "run-delegation",
    organizationId: input.organizationId,
  });
  if (value === undefined) return undefined;
  if (
    value.itemType !== "run-delegation" ||
    value.data.childRunId !== context.parentRunId ||
    value.data.childThreadId !== context.parentThreadId ||
    value.data.childAgentDeploymentId !== context.parentAgentDeploymentId ||
    value.data.organizationId !== input.organizationId ||
    value.data.projectId !== input.projectId ||
    value.data.environmentId !== input.environmentId
  ) {
    throw new ConversationError(
      "trace_mismatch",
      "Parent delegation link does not match the trace context.",
    );
  }
  return value;
}

/** Builds the immutable child-to-parent link written in the child run's submission transaction. */
export function runDelegationRecord(args: {
  readonly input: SubmitConversationTurnInput;
  readonly parentDelegation?: ConversationRunDelegation;
  readonly run: ConversationRun;
  readonly timestamp: string;
}): ConversationRunDelegation | undefined {
  const context = args.input.traceContext;
  if (!context) return undefined;
  const ancestors = [
    ...(args.parentDelegation?.data.ancestorAgentDeploymentIds ?? []),
    context.parentAgentDeploymentId,
  ];
  if (ancestors.length > MAX_RUN_DELEGATION_ANCESTORS) {
    throw new ConversationError(
      "trace_run_limit",
      `Delegation chains cannot exceed ${MAX_RUN_DELEGATION_ANCESTORS} runs.`,
    );
  }
  return Schema.decodeUnknownSync(RunDelegationRecord)(
    withCanonicalRecordKeys({
      data: {
        ancestorAgentDeploymentIds: ancestors,
        awaitResult: context.awaitResult === true,
        childAgentDeploymentId: args.run.data.agentDeploymentId,
        childRunId: args.run.data.id,
        childThreadId: args.run.data.threadId,
        createdAt: args.timestamp,
        depth: (args.parentDelegation?.data.depth ?? 0) + 1,
        edgeKind: context.edgeKind ?? "delegation",
        environmentId: args.run.data.environmentId,
        organizationId: args.run.data.organizationId,
        parentAgentDeploymentId: context.parentAgentDeploymentId,
        parentRunId: context.parentRunId,
        parentThreadId: context.parentThreadId,
        projectId: args.run.data.projectId,
      },
      itemType: "run-delegation" as const,
    }),
  );
}
