import type { PublicApiQueryParameter } from "@deployments-ai/api-contract";

const RFC_3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

function invalidValue(value: string, schema: Readonly<Record<string, unknown>>) {
  if (schema.type === "integer") {
    const parsed = Number(value);
    return (
      !/^\d+$/u.test(value) ||
      !Number.isSafeInteger(parsed) ||
      (typeof schema.minimum === "number" && parsed < schema.minimum) ||
      (typeof schema.maximum === "number" && parsed > schema.maximum)
    );
  }
  return (
    (Array.isArray(schema.enum) && !schema.enum.includes(value)) ||
    (schema.format === "date-time" &&
      (!RFC_3339.test(value) || !Number.isFinite(Date.parse(value)))) ||
    (typeof schema.minLength === "number" && value.length < schema.minLength) ||
    (typeof schema.maxLength === "number" && value.length > schema.maxLength) ||
    (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value))
  );
}

/**
 * Validates a request's query string against the route contract: only declared parameters, at
 * most once each, matching their declared schema. Returns a problem detail, or undefined.
 */
export function queryParameterProblem(
  searchParams: URLSearchParams,
  declared: readonly PublicApiQueryParameter[] = [],
): string | undefined {
  for (const name of new Set(searchParams.keys())) {
    const parameter = declared.find((candidate) => candidate.name === name);
    if (!parameter) return `Query parameter ${name} is not supported by this operation.`;
    const values = searchParams.getAll(name);
    if (values.length > 1) return `Query parameter ${name} may appear only once.`;
    if (invalidValue(values[0]!, parameter.schema)) return `Query parameter ${name} is invalid.`;
  }
  for (const parameter of declared) {
    if (parameter.required && !searchParams.has(parameter.name)) {
      return `Query parameter ${parameter.name} is required.`;
    }
  }
  return undefined;
}
