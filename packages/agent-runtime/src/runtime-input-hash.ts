import { createHash } from "node:crypto";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") {
    throw new TypeError("Runtime tool input must contain only JSON values.");
  }
  return `{${Object.keys(value)
    .toSorted()
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
}

/** Stable SHA-256 binding for the exact JSON input authorized for tool execution. */
export function runtimeToolInputHash(input: Readonly<Record<string, unknown>>): string {
  return `sha256:${createHash("sha256").update(canonicalJson(input)).digest("hex")}`;
}
