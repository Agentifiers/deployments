import type { JsonSchema } from "./openapi-types.ts";

const CONSTRAINT_KEYWORDS = new Set([
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "multipleOf",
  "pattern",
  "uniqueItems",
]);

const JSON_VALUE_TYPES = ["array", "boolean", "null", "number", "object", "string"];

export function isSchema(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The API page example sampler (`@fumadocs/json-schema` `sample`) drops `allOf` constraints on
 * array schemas: `{ type: "array", allOf: [{ minItems: 1 }] }` samples as `[]`.
 */
function hoistConstraintFragments(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(hoistConstraintFragments);
  if (!isSchema(value)) return value;
  const schema: Record<string, unknown> = Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, hoistConstraintFragments(nested)]),
  );
  if (!Array.isArray(schema.allOf)) return schema;
  const remaining: unknown[] = [];
  for (const fragment of schema.allOf) {
    const keys = isSchema(fragment) ? Object.keys(fragment) : [];
    if (
      isSchema(fragment) &&
      keys.length > 0 &&
      keys.every((key) => CONSTRAINT_KEYWORDS.has(key) && !(key in schema))
    ) {
      Object.assign(schema, fragment);
    } else {
      remaining.push(fragment);
    }
  }
  if (remaining.length > 0) schema.allOf = remaining;
  else delete schema.allOf;
  return schema;
}

// The API page's schema renderer overflows the stack on an array whose items are this
// self-referencing JSON value, which is readThreadStream's response shape.
function withoutJsonValueRecursion(name: string, schema: JsonSchema): JsonSchema {
  const selfReference = `#/components/schemas/${name}`;
  const variants = Array.isArray(schema.anyOf) ? schema.anyOf.filter(isSchema) : [];
  const isSelf = (candidate: unknown) => isSchema(candidate) && candidate.$ref === selfReference;
  const matches =
    variants.length === JSON_VALUE_TYPES.length &&
    JSON_VALUE_TYPES.every((type) => variants.some((variant) => variant.type === type)) &&
    variants.every(
      (variant) =>
        (variant.type === "array" && isSelf(variant.items) && Object.keys(variant).length === 2) ||
        (variant.type === "object" &&
          isSelf(variant.additionalProperties) &&
          Object.keys(variant).length === 2) ||
        Object.keys(variant).length === 1,
    );
  if (!matches) return schema;
  return {
    ...schema,
    anyOf: variants.map((variant) =>
      variant.type === "array"
        ? { type: "array", items: {} }
        : variant.type === "object"
          ? { type: "object", additionalProperties: {} }
          : variant,
    ),
  };
}

export function normalizeSchema(schema: JsonSchema): JsonSchema {
  const hoisted = hoistConstraintFragments(schema);
  return isSchema(hoisted) ? hoisted : schema;
}

export function normalizeComponentSchemas(
  schemas: Readonly<Record<string, JsonSchema>>,
): Record<string, JsonSchema> {
  return Object.fromEntries(
    Object.entries(schemas).map(([name, schema]) => [
      name,
      withoutJsonValueRecursion(name, normalizeSchema(schema)),
    ]),
  );
}
