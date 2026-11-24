import type { ScorerResult } from "./types.ts";

export interface ContainsParameters {
  readonly values: readonly string[];
  readonly mode: "all" | "any";
  readonly caseSensitive: boolean;
}

export interface NotContainsParameters {
  readonly values: readonly string[];
  readonly caseSensitive: boolean;
}

/** Which of `values` occur in `output`; case-insensitive comparison uses Unicode lowercasing. */
function occurrences(
  values: readonly string[],
  output: string,
  caseSensitive: boolean,
): readonly boolean[] {
  const haystack = caseSensitive ? output : output.toLowerCase();
  return values.map((value) => haystack.includes(caseSensitive ? value : value.toLowerCase()));
}

/** "all": fraction of values found. "any": 1 when at least one value is found. */
export function scoreContains(parameters: ContainsParameters, output: string): ScorerResult {
  const found = occurrences(parameters.values, output, parameters.caseSensitive).filter(
    Boolean,
  ).length;
  const total = parameters.values.length;
  const value = parameters.mode === "any" ? (found > 0 ? 1 : 0) : found / total;
  return {
    status: "succeeded",
    value,
    rationale: `The response contains ${found} of ${total} ${parameters.mode === "any" ? "candidate" : "required"} values.`,
  };
}

/** Fraction of forbidden values absent from the response. */
export function scoreNotContains(parameters: NotContainsParameters, output: string): ScorerResult {
  const found = occurrences(parameters.values, output, parameters.caseSensitive).filter(
    Boolean,
  ).length;
  const total = parameters.values.length;
  return {
    status: "succeeded",
    value: (total - found) / total,
    rationale: `The response contains ${found} of ${total} forbidden values.`,
  };
}
