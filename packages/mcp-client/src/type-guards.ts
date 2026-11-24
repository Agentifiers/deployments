/** Canonical plain-object guard for this package; fields stay `unknown` until checked. */
export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
