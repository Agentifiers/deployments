import Ajv, { type ValidateFunction } from "ajv";
import { canonicalJson } from "./canonical-hash.ts";
import { MAX_SCORE_RATIONALE_LENGTH } from "./config.ts";
import { linearRegExpEngine } from "./linear-regex.ts";
import { boundedText, scorerError, type ScorerResult } from "./types.ts";

const MAX_CACHED_SCHEMAS = 32;
const validator = new Ajv({
  allErrors: false,
  strict: false,
  validateFormats: false,
  addUsedSchema: false,
  ownProperties: true,
  // Schema `pattern` and `patternProperties` come from users and run against untrusted output.
  code: { regExp: linearRegExpEngine },
});
const validators = new Map<string, ValidateFunction>();
const FENCED_JSON = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/iu;

/** The compiled validator, or an error message when the schema does not compile. */
export function compileJsonSchema(
  schema: Readonly<Record<string, unknown>>,
): ValidateFunction | string {
  const key = canonicalJson(schema);
  const cached = validators.get(key);
  if (cached) return cached;
  let compiled: ValidateFunction;
  try {
    compiled = validator.compile(schema);
  } catch (cause) {
    const detail = cause instanceof Error ? `: ${cause.message}` : ".";
    return boundedText(`The JSON schema does not compile${detail}`, MAX_SCORE_RATIONALE_LENGTH);
  } finally {
    // Ajv also keeps its own schema-object cache; retain only the bounded content cache.
    validator.removeSchema(schema);
  }
  // Async validators return promises (always truthy), so they cannot score synchronously.
  if ("$async" in compiled && compiled.$async === true)
    return "Asynchronous JSON schemas are not supported.";
  if (validators.size >= MAX_CACHED_SCHEMAS) validators.delete(validators.keys().next().value!);
  validators.set(key, compiled);
  return compiled;
}

/**
 * Parses a response that is bare JSON or exactly one fenced ```json block. Returns
 * `undefined` when the text is not JSON.
 */
export function parseJsonResponse(text: string): { readonly value: unknown } | undefined {
  const trimmed = text.trim();
  const body = FENCED_JSON.exec(trimmed)?.[1] ?? trimmed;
  try {
    return { value: JSON.parse(body) };
  } catch {
    return undefined;
  }
}

/**
 * 1 when the response satisfies the schema, 0 otherwise. Structured output wins over the
 * response text. Unparseable text is an agent failure (value 0, label `invalid_json`).
 */
export function scoreJsonSchema(
  schema: Readonly<Record<string, unknown>>,
  evidence: { readonly output?: string; readonly structuredOutput?: unknown },
): ScorerResult {
  const validate = compileJsonSchema(schema);
  if (typeof validate === "string") return scorerError("invalid_configuration", validate);
  let document: unknown;
  if (evidence.structuredOutput !== undefined) document = evidence.structuredOutput;
  else if (evidence.output === undefined)
    return scorerError("missing_evidence", "The run has no final response.");
  else {
    const parsed = parseJsonResponse(evidence.output);
    if (!parsed)
      return {
        status: "succeeded",
        value: 0,
        label: "invalid_json",
        rationale: "The final response is not valid JSON.",
      };
    document = parsed.value;
  }
  if (validate(document))
    return { status: "succeeded", value: 1, rationale: "The response satisfies the schema." };
  const error = validate.errors?.[0];
  return {
    status: "succeeded",
    value: 0,
    rationale: boundedText(
      error
        ? `${error.instancePath || "/"} ${error.message ?? "does not satisfy the schema"}`
        : "The response does not satisfy the schema.",
      MAX_SCORE_RATIONALE_LENGTH,
    ),
  };
}
