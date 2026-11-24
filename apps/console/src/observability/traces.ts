import type {
  ObservabilitySpanResponse,
  ObservabilityTraceSummary,
} from "@deployments-ai/api-contract/observability";

export type TraceSummary = typeof ObservabilityTraceSummary.Type;
export type SpanSummary = typeof ObservabilitySpanResponse.Type;

/** A trace summary with its agent and release named from the environment's agent directory. */
export interface LabeledTrace extends TraceSummary {
  readonly agentLabel?: string;
  readonly releaseLabel?: string;
}

export interface ToolMetric {
  readonly calls: number;
  readonly errors: number;
  readonly name: string;
  readonly p95DurationMs?: number;
}
