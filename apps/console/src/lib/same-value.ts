/** JSON with object keys sorted, since a built body and a stored record may order them apart. */
function canonical(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, nested: unknown) =>
    typeof nested === "object" && nested !== null && !Array.isArray(nested)
      ? Object.fromEntries(
          Object.entries(nested).toSorted(([left], [right]) => left.localeCompare(right)),
        )
      : nested,
  );
}

/** Whether a stored field already holds a value; absent and `null` are the same. */
export function sameValue(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}
