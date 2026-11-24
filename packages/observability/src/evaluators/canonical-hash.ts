import { createHash } from "node:crypto";
import { EVALUATOR_CATALOG_VERSION, type EvaluatorConfig, type ScoreTarget } from "./config.ts";

/**
 * JSON with object keys sorted by UTF-16 code unit order and no insignificant whitespace.
 * The ordering is locale-independent so identical values hash identically everywhere.
 */
export function canonicalJson(value: unknown): string {
  const text = JSON.stringify(value, (_key, child: unknown) =>
    child !== null && typeof child === "object" && !Array.isArray(child)
      ? Object.fromEntries(
          Object.keys(child)
            .sort()
            .map((key) => [key, (child as Record<string, unknown>)[key]]),
        )
      : child,
  );
  if (text === undefined) throw new TypeError("Value has no JSON representation.");
  return text;
}

/** Lowercase hex SHA-256 of the UTF-8 encoding of `text`. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Identifies the exact scoring semantics of a score definition revision. Results with
 * different hashes are never treated as the same evaluator version.
 */
export function evaluatorVersionHash(input: {
  readonly evaluator: EvaluatorConfig;
  readonly threshold: number;
  readonly target: ScoreTarget;
}): string {
  return sha256Hex(
    canonicalJson({
      catalogVersion: EVALUATOR_CATALOG_VERSION,
      evaluator: input.evaluator,
      target: input.target,
      threshold: input.threshold,
    }),
  );
}

export function judgePromptHash(prompt: string): string {
  return sha256Hex(prompt);
}

/**
 * Deterministic per-trace sampling: the same trace and definition always make the same
 * decision, so retries never change which traces are scored.
 */
export function sampledForAutomaticScoring(
  traceId: string,
  scoreDefinitionId: string,
  rate: number,
): boolean {
  if (!(rate > 0)) return false;
  if (rate >= 1) return true;
  const bucket = Number.parseInt(sha256Hex(`${traceId}\u0000${scoreDefinitionId}`).slice(0, 8), 16);
  return bucket / 0xffffffff < rate;
}

/** Higher is better: a score passes when it reaches the threshold. */
export function scorePassed(value: number, threshold: number): boolean {
  return value >= threshold;
}
