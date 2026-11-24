import { MAX_REGEX_PATTERN_LENGTH } from "./config.ts";
import { compileLinearRegex, type LinearRegex, UnsupportedRegexError } from "./linear-regex.ts";
import { scorerError, type ScorerResult } from "./types.ts";

/** Responses are truncated to this many UTF-16 code units before matching. */
export const MAX_REGEX_INPUT_LENGTH = 65_536;

export interface RegexParameters {
  readonly pattern: string;
  readonly flags?: string | undefined;
}

/**
 * An error message when the pattern is too long, invalid, or cannot run on the linear-time
 * engine; otherwise the compiled expression. Patterns must be valid ECMAScript and supported by
 * RE2, so matching untrusted responses never backtracks catastrophically.
 */
export function compileSafeRegex(parameters: RegexParameters): LinearRegex | string {
  if (parameters.pattern.length === 0) return "Regular expression patterns must not be empty.";
  if (parameters.pattern.length > MAX_REGEX_PATTERN_LENGTH)
    return `Regular expression patterns must not exceed ${MAX_REGEX_PATTERN_LENGTH} characters.`;
  if (parameters.flags !== undefined && !/^(?!.*(.).*\1)[imsu]{0,4}$/u.test(parameters.flags))
    return "Regular expression flags may only contain distinct i, m, s, and u flags.";
  try {
    return compileLinearRegex(parameters.pattern, parameters.flags);
  } catch (cause) {
    if (!(cause instanceof UnsupportedRegexError))
      return "The regular expression pattern is invalid.";
    return `Regular expressions must not use backreferences, lookaround, or other constructs without linear-time matching (${cause.message}).`;
  }
}

/** 1 when the (truncated) response matches the expression, else 0. */
export function scoreRegex(parameters: RegexParameters, output: string): ScorerResult {
  const expression = compileSafeRegex(parameters);
  if (typeof expression === "string") return scorerError("invalid_configuration", expression);
  const matched = expression.test(output.slice(0, MAX_REGEX_INPUT_LENGTH));
  return {
    status: "succeeded",
    value: matched ? 1 : 0,
    rationale: matched
      ? "The response matches the expression."
      : "The response does not match the expression.",
  };
}
