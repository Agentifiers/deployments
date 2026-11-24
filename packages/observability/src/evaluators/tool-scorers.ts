import type { EvaluationToolCallEvidence, ScorerResult } from "./types.ts";

export interface ToolCalledParameters {
  readonly tools: readonly string[];
  readonly mode: "all" | "any";
}

/** "all": fraction of required tools called (any status). "any": 1 when any was called. */
export function scoreToolCalled(
  parameters: ToolCalledParameters,
  toolCalls: readonly EvaluationToolCallEvidence[],
): ScorerResult {
  const called = new Set(toolCalls.map((call) => call.name));
  const required = [...new Set(parameters.tools)];
  const found = required.filter((tool) => called.has(tool)).length;
  const value = parameters.mode === "any" ? (found > 0 ? 1 : 0) : found / required.length;
  return {
    status: "succeeded",
    value,
    rationale: `The run called ${found} of ${required.length} ${parameters.mode === "any" ? "candidate" : "required"} tools.`,
  };
}

/**
 * 1 when none of the forbidden tools were called. Without a tool list any tool call fails.
 */
export function scoreNoTool(
  forbidden: readonly string[] | undefined,
  toolCalls: readonly EvaluationToolCallEvidence[],
): ScorerResult {
  if (forbidden === undefined) {
    return {
      status: "succeeded",
      value: toolCalls.length === 0 ? 1 : 0,
      rationale: `The run made ${toolCalls.length} tool calls; none are allowed.`,
    };
  }
  const forbiddenNames = new Set(forbidden);
  const violations = new Set(
    toolCalls.filter((call) => forbiddenNames.has(call.name)).map((call) => call.name),
  ).size;
  return {
    status: "succeeded",
    value: violations === 0 ? 1 : 0,
    rationale: `The run called ${violations} of ${forbiddenNames.size} forbidden tools.`,
  };
}
