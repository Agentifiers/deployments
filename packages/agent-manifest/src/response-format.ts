import Ajv, { type ValidateFunction } from "ajv";
import { Schema, SchemaTransformation } from "effect";
import { isJsonValueWithinDepth } from "./json.ts";
import type { JsonValue } from "./schema.ts";

export const MAX_RESPONSE_SCHEMA_BYTES = 64 * 1024;
export const MAX_STRUCTURED_RESPONSE_BYTES = 256 * 1024;
const MAX_SCHEMA_DEPTH = 24;
const MAX_SCHEMA_NODES = 2048;
const MAX_CACHED_SCHEMAS = 32;
const encoder = new TextEncoder();
// Deliberately bounded draft-07 vocabulary. References, regexes, remote resources,
// custom formats and recursive schemas are not accepted from untrusted callers.
const keywords = [
  "type",
  "title",
  "description",
  "default",
  "examples",
  "const",
  "enum",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minProperties",
  "maxProperties",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "uniqueItems",
];
const validator = new Ajv({
  allErrors: false,
  strict: false,
  validateFormats: false,
  addUsedSchema: false,
  ownProperties: true,
});
const validators = new Map<string, ValidateFunction>();

export function canonicalResponseFormatJson(value: unknown): string {
  return JSON.stringify(value, (_key, child: unknown) =>
    child && typeof child === "object" && !Array.isArray(child)
      ? Object.fromEntries(
          Object.entries(child).toSorted(([left], [right]) => left.localeCompare(right)),
        )
      : child,
  );
}

function boundedSchema(schema: Readonly<Record<string, JsonValue>>): boolean {
  if (!isJsonValueWithinDepth(schema, 64)) return false;
  if (encoder.encode(JSON.stringify(schema)).byteLength > MAX_RESPONSE_SCHEMA_BYTES) return false;
  const pending: Array<{ value: unknown; depth: number }> = [{ value: schema, depth: 0 }];
  let nodes = 0;
  while (pending.length > 0) {
    const { value, depth } = pending.pop()!;
    if (++nodes > MAX_SCHEMA_NODES || depth > MAX_SCHEMA_DEPTH) return false;
    if (typeof value === "boolean") continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const node = value as Readonly<Record<string, unknown>>;
    if (
      node.uniqueItems === true &&
      (typeof node.maxItems !== "number" ||
        !Number.isSafeInteger(node.maxItems) ||
        node.maxItems < 0 ||
        node.maxItems > 256)
    )
      return false;
    for (const [keyword, child] of Object.entries(value)) {
      if (!keywords.includes(keyword)) return false;
      if (keyword === "properties") {
        if (!child || typeof child !== "object" || Array.isArray(child)) return false;
        for (const property of Object.values(child))
          pending.push({ value: property, depth: depth + 1 });
      } else if (["items", "additionalProperties", "not"].includes(keyword)) {
        // Tuple schemas are excluded; one item contract keeps array validation linear.
        pending.push({ value: child, depth: depth + 1 });
      } else if (["anyOf", "oneOf", "allOf"].includes(keyword)) {
        if (!Array.isArray(child) || child.length === 0 || child.length > 64) return false;
        for (const branch of child) pending.push({ value: branch, depth: depth + 1 });
      }
    }
  }
  return true;
}

function compiledSchema(schema: Readonly<Record<string, JsonValue>>): ValidateFunction {
  if (!boundedSchema(schema))
    throw new TypeError("Response schema exceeds limits or uses unsupported JSON Schema keywords.");
  const key = canonicalResponseFormatJson(schema);
  const cached = validators.get(key);
  if (cached) return cached;
  const compiled = validator.compile(schema);
  // Ajv also keeps its own schema-object cache; retain only our bounded content cache.
  validator.removeSchema(schema);
  if (validators.size >= MAX_CACHED_SCHEMAS) validators.delete(validators.keys().next().value!);
  validators.set(key, compiled);
  return compiled;
}

const ResponseSchemaValueJson: Schema.Codec<JsonValue> = Schema.Union([
  Schema.Null,
  Schema.Boolean,
  Schema.Number,
  Schema.String,
  Schema.Array(Schema.suspend(() => ResponseSchemaValue)),
  Schema.Record(
    Schema.String,
    Schema.suspend(() => ResponseSchemaValue),
  ),
]);
const ResponseSchemaValue = Schema.declare<JsonValue>(
  (value): value is JsonValue => isJsonValueWithinDepth(value, 64),
  {
    title: "ResponseSchemaValue",
    toCodecJson: () =>
      Schema.link<JsonValue>()(
        ResponseSchemaValueJson,
        SchemaTransformation.transform({ decode: (value) => value, encode: (value) => value }),
      ),
  },
);

export const AgentResponseFormat = Schema.Struct({
  type: Schema.Literal("json_schema"),
  name: Schema.String.pipe(
    Schema.check(
      Schema.makeFilter<string>((value) =>
        /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(value)
          ? undefined
          : "Response format name is invalid.",
      ),
    ),
  ),
  schema: Schema.Record(Schema.String, ResponseSchemaValue).pipe(
    Schema.check(
      Schema.makeFilter<Readonly<Record<string, JsonValue>>>((value) => {
        try {
          compiledSchema(value);
          return undefined;
        } catch {
          return "Response schema must be a bounded draft-07 schema using supported keywords and no references or regular expressions.";
        }
      }),
    ),
  ),
});
export type AgentResponseFormat = typeof AgentResponseFormat.Type;

/** Validate only a final assistant response; never include model output in an error. */
export function validateStructuredResponse(text: string, format: AgentResponseFormat): void {
  if (encoder.encode(text).byteLength > MAX_STRUCTURED_RESPONSE_BYTES) {
    throw new Error("Structured response exceeds the 262144-byte output limit.");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Model returned invalid JSON for the requested response format.");
  }
  if (!isJsonValueWithinDepth(value, 32) || !compiledSchema(format.schema)(value)) {
    throw new Error("Model JSON does not satisfy the requested response schema.");
  }
}
