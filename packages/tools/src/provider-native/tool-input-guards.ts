import { optionalToolObject } from "./core.ts";

const SECRET_KEY_PATTERN =
  /(?:api[-_]?key|authorization|client[-_]?secret|password|private[-_]?key|secret|token)/iu;

export function requiredObject(
  input: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = optionalToolObject(input, key);
  if (!value || Object.keys(value).length === 0) throw new Error(`Tool input ${key} is required`);
  return value;
}

export function assertSafeJsonValue(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSafeJsonValue(entry, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      throw new Error(`Tool input ${path}.${key} must not contain credential material`);
    }
    assertSafeJsonValue(child, `${path}.${key}`);
  }
}
