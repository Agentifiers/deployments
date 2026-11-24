import type { CaseExpectations, EvaluatorErrorClass } from "./config.ts";

/** One tool call observed in the scored run, regardless of whether it succeeded. */
export interface EvaluationToolCallEvidence {
  readonly name: string;
  readonly status: string;
}

/** Evidence an evaluator reads. Evaluators never fetch evidence themselves. */
export interface EvaluationEvidence {
  /** User content that started the run. */
  readonly input?: string;
  /** Final assistant response text; `undefined` means the evidence is missing. */
  readonly output?: string;
  /** Parsed structured output when the run used a JSON response format. */
  readonly structuredOutput?: unknown;
  /** Tool calls the run made; `undefined` means the evidence is missing. */
  readonly toolCalls?: readonly EvaluationToolCallEvidence[];
  /** Case expectations; `{}` for plain trace scoring. */
  readonly expectations: CaseExpectations;
}

/** Model usage spent by an evaluator; always marked internal so it is metered separately. */
export interface EvaluatorUsage {
  readonly modelId: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsdMicros?: number;
  readonly internalEvaluator: true;
}

export type EvaluatorOutcome =
  | {
      readonly status: "succeeded";
      readonly value: number;
      readonly label?: string;
      readonly rationale?: string;
      readonly durationMs: number;
      readonly usage?: EvaluatorUsage;
    }
  | { readonly status: "not_applicable" }
  | {
      readonly status: "error";
      readonly errorClass: EvaluatorErrorClass;
      readonly message: string;
      readonly durationMs: number;
      readonly usage?: EvaluatorUsage;
    };

/** An evaluator outcome before the runner attaches its measured duration. */
export type ScorerResult =
  | {
      readonly status: "succeeded";
      readonly value: number;
      readonly label?: string;
      readonly rationale?: string;
      readonly usage?: EvaluatorUsage;
    }
  | { readonly status: "not_applicable" }
  | {
      readonly status: "error";
      readonly errorClass: EvaluatorErrorClass;
      readonly message: string;
      readonly usage?: EvaluatorUsage;
    };

export interface JudgeModelRequest {
  readonly modelId: string;
  readonly system: string;
  readonly user: string;
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
  readonly internalEvaluator: true;
  readonly responseSchema: Readonly<Record<string, unknown>>;
}

export interface JudgeModelResponse {
  readonly text: string;
  readonly modelId?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly costUsdMicros?: number;
}

/** Model access for judge evaluators; implemented by infrastructure adapters. */
export interface JudgeModelPort {
  readonly complete: (request: JudgeModelRequest) => Promise<JudgeModelResponse>;
}

/** Thrown by judge port implementations when the model request exceeds its timeout. */
export class JudgeModelTimeoutError extends Error {
  override readonly name = "JudgeModelTimeoutError";
}

export interface EvaluatorDependencies {
  readonly judge?: JudgeModelPort;
  readonly now?: () => number;
}

export function scorerError(errorClass: EvaluatorErrorClass, message: string): ScorerResult {
  return { status: "error", errorClass, message };
}

/** Truncate a rationale or label to a stored bound without splitting a surrogate pair. */
export function boundedText(text: string, maximum: number): string {
  if (text.length <= maximum) return text;
  const code = text.charCodeAt(maximum - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? maximum - 1 : maximum);
}
