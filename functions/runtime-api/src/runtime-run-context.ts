import {
  key,
  makeExecutionBindingPersistence,
  type PlatformRecord,
  type TransactionOperation,
} from "@deployments-ai/db";
import {
  executionTargetConditions,
  validateRunExecutionTarget,
  type RunExecutionTarget,
} from "@deployments-ai/worker/agent-run";
import {
  RuntimeApiError,
  assertRecord,
  getRecord,
  loadThread,
  scoped,
  type RuntimeApiDependencies,
  type RuntimeApiPrincipal,
} from "./runtime-support.ts";

type RunRecordValue = Extract<PlatformRecord, { readonly itemType: "run" }>;
type ThreadRecordValue = Extract<PlatformRecord, { readonly itemType: "thread" }>;

/**
 * A run's executable context: its thread plus the execution target it is pinned to (a ready
 * deployment and active release for customer runs, an active execution binding for preview and
 * evaluation runs), validated at `at`.
 */
export interface RunnableRunContext {
  readonly at: Date;
  readonly target: RunExecutionTarget;
  readonly thread: ThreadRecordValue;
}

async function loadRunExecutionTarget(
  dependencies: RuntimeApiDependencies,
  principal: RuntimeApiPrincipal,
  run: RunRecordValue,
): Promise<RunExecutionTarget> {
  if (run.data.executionBindingId === undefined) {
    const partition = key("ORG", run.data.organizationId, "ENV", run.data.environmentId);
    const [deploymentValue, releaseValue] = await Promise.all([
      getRecord(dependencies.database, "control", {
        pk: partition,
        sk: key("AGENT-DEPLOYMENT", run.data.agentDeploymentId),
      }),
      getRecord(dependencies.database, "control", {
        pk: partition,
        sk: key("AGENT-RELEASE", run.data.agentReleaseId),
      }),
    ]);
    return {
      deployment: scoped(
        assertRecord(deploymentValue, "agent-deployment", "Agent deployment"),
        principal,
      ),
      kind: "deployment",
      release: scoped(assertRecord(releaseValue, "agent-release", "Agent release"), principal),
    };
  }
  const binding = await makeExecutionBindingPersistence(dependencies.database).get({
    environmentId: run.data.environmentId,
    executionBindingId: run.data.executionBindingId,
    organizationId: run.data.organizationId,
  });
  return {
    binding: scoped(assertRecord(binding, "execution-binding", "Execution binding"), principal),
    kind: "binding",
  };
}

export async function loadRunnableRunContext(
  dependencies: RuntimeApiDependencies,
  principal: RuntimeApiPrincipal,
  run: RunRecordValue,
): Promise<RunnableRunContext> {
  const [thread, target] = await Promise.all([
    loadThread(dependencies, principal, run.data.threadId),
    loadRunExecutionTarget(dependencies, principal, run),
  ]);
  const at = dependencies.now?.() ?? new Date();
  try {
    validateRunExecutionTarget(run, thread, target, at);
  } catch (cause) {
    const expired =
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === "execution_binding_expired";
    throw new RuntimeApiError(
      409,
      expired ? "execution_binding_expired" : "run_not_executable",
      cause instanceof Error ? cause.message : "Run execution pins are unavailable.",
    );
  }
  return { at, target, thread };
}

export function runnableRunConditionChecks(
  context: RunnableRunContext,
  includeThread: boolean,
): readonly TransactionOperation[] {
  return [
    ...(includeThread
      ? [
          {
            conditionExpression: "#data.#version = :version AND #data.#archived = :archived",
            expressionAttributeNames: {
              "#archived": "archived",
              "#data": "data",
              "#version": "version",
            },
            expressionAttributeValues: {
              ":archived": false,
              ":version": context.thread.data.version,
            },
            key: { pk: context.thread.pk, sk: context.thread.sk },
            kind: "condition-check" as const,
            table: "execution" as const,
          },
        ]
      : []),
    ...executionTargetConditions(context.target, context.at),
  ];
}
