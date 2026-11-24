import {
  key,
  type DynamoDatabaseService,
  type PlatformRecord,
  workerPersistence,
} from "@deployments-ai/db";

type Run = Extract<PlatformRecord, { readonly itemType: "run" }>;
type Invocation = Extract<PlatformRecord, { readonly itemType: "model-invocation" }>;

/** Error class of an errored trace whose runs recorded no classified model failure. */
export const UNCLASSIFIED_TRACE_ERROR_CLASS = "run_failed";

/**
 * The root run's final model invocation explains the failure when it failed; otherwise the
 * earliest classified model failure anywhere in the trace (for example a delegated child run).
 */
export function traceErrorClass(rootRunId: string, invocations: readonly Invocation[]): string {
  const ordered = [...invocations].sort(
    (left, right) =>
      Date.parse(left.data.completedAt) - Date.parse(right.data.completedAt) ||
      left.data.invocationId.localeCompare(right.data.invocationId),
  );
  const rootTerminal = ordered.filter((invocation) => invocation.data.runId === rootRunId).at(-1);
  if (rootTerminal?.data.status === "failed" && rootTerminal.data.errorClass) {
    return rootTerminal.data.errorClass;
  }
  return (
    ordered.find((invocation) => invocation.data.status === "failed" && invocation.data.errorClass)
      ?.data.errorClass ?? UNCLASSIFIED_TRACE_ERROR_CLASS
  );
}

async function releaseDefinitionId(database: DynamoDatabaseService, root: Run) {
  const releaseId = root.data.agentReleaseId;
  if (!releaseId) return undefined;
  const release = await workerPersistence.read(
    database,
    "control",
    {
      pk: key("ORG", root.data.organizationId, "ENV", root.data.environmentId),
      sk: key("AGENT-RELEASE", releaseId),
    },
    true,
  );
  return release?.itemType === "agent-release" && release.data.id === releaseId
    ? release.data.agentDefinitionId
    : undefined;
}

/**
 * Agent identity and outcome summary stamped on a trace when it finalizes. Identity comes from
 * the root run (the definition through the root run's pinned release); `durationMs` spans the
 * root run start to the trace completion.
 */
export async function traceRootSummary(
  database: DynamoDatabaseService,
  input: {
    readonly completedAt: string;
    readonly invocations: readonly Invocation[];
    readonly outcome: "canceled" | "error" | "ok";
    readonly root: Run;
  },
) {
  const { root } = input;
  const agentDefinitionId = await releaseDefinitionId(database, root);
  const durationMs =
    Date.parse(input.completedAt) - Date.parse(root.data.startedAt ?? root.data.createdAt);
  return {
    ...(agentDefinitionId ? { agentDefinitionId } : {}),
    ...(root.data.agentDeploymentId ? { agentDeploymentId: root.data.agentDeploymentId } : {}),
    ...(root.data.agentReleaseId ? { agentReleaseId: root.data.agentReleaseId } : {}),
    ...(Number.isFinite(durationMs) ? { durationMs: Math.max(0, durationMs) } : {}),
    ...(input.outcome === "error"
      ? { errorClass: traceErrorClass(root.data.id, input.invocations) }
      : {}),
    executionPurpose: root.data.executionPurpose ?? ("customer" as const),
    ...(root.data.releaseSelection ? { releaseSelection: root.data.releaseSelection } : {}),
    ...(root.data.trigger ? { trigger: root.data.trigger } : {}),
  };
}
