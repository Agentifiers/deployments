import { createHash } from "node:crypto";
import type { TraceId } from "./identifier-codecs.ts";

export const TERMINAL_RUN_STATUSES = new Set(["canceled", "completed", "failed"]);

export interface TraceGraphRun {
  readonly id: string;
  readonly status: string;
  readonly traceId: TraceId;
  readonly version: number;
}

export interface TraceGraphEdge {
  readonly childRunId: string;
  readonly parentRunId: string;
  readonly traceId: TraceId;
  readonly version: number;
}

export interface TraceCompletionEvaluation {
  readonly complete: boolean;
  readonly graphWatermark: string;
  readonly pendingRunIds: readonly string[];
  readonly runIds: readonly string[];
}

export function evaluateTraceCompletion(input: {
  readonly edges: readonly TraceGraphEdge[];
  readonly rootRunId: string;
  readonly runs: readonly TraceGraphRun[];
  readonly traceId: TraceId;
}): TraceCompletionEvaluation {
  const runById = new Map(input.runs.map((run) => [run.id, run] as const));
  const childrenByParent = new Map<string, string[]>();
  for (const edge of input.edges) {
    if (edge.traceId !== input.traceId) throw new Error("Trace edge belongs to another trace.");
    const children = childrenByParent.get(edge.parentRunId) ?? [];
    children.push(edge.childRunId);
    childrenByParent.set(edge.parentRunId, children);
  }

  const reachable = new Set<string>();
  const visiting = new Set<string>();
  const visit = (runId: string) => {
    if (visiting.has(runId)) throw new Error("Trace run graph contains a cycle.");
    if (reachable.has(runId)) return;
    visiting.add(runId);
    reachable.add(runId);
    for (const childRunId of childrenByParent.get(runId) ?? []) visit(childRunId);
    visiting.delete(runId);
  };
  visit(input.rootRunId);

  for (const run of input.runs) {
    if (run.traceId !== input.traceId) throw new Error("Trace run belongs to another trace.");
  }
  const runIds = [...new Set([...reachable, ...input.runs.map((run) => run.id)])].toSorted();
  const pendingRunIds = runIds.filter((runId) => {
    const run = runById.get(runId);
    if (!run || !reachable.has(runId)) return true;
    return !TERMINAL_RUN_STATUSES.has(run.status);
  });
  const graphWatermark = `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        edges: input.edges
          .filter((edge) => reachable.has(edge.parentRunId))
          .map((edge) => [edge.parentRunId, edge.childRunId, edge.version] as const)
          .toSorted((left, right) => {
            // Preserve the default sort order (comma-joined UTF-16 comparison) baked into
            // existing graph watermarks.
            const leftKey = left.join(",");
            const rightKey = right.join(",");
            return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
          }),
        runs: runIds.map((runId) => [runId, runById.get(runId)?.version ?? null]),
        traceId: input.traceId,
      }),
    )
    .digest("hex")}`;
  return {
    complete: pendingRunIds.length === 0,
    graphWatermark,
    pendingRunIds,
    runIds,
  };
}
