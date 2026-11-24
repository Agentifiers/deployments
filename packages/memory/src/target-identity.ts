import { createHash } from "node:crypto";
import type { MemorySearchTarget } from "./provider.ts";

function stableTargetValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableTargetValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([name, child]) => [name, stableTargetValue(child)]),
    );
  }
  return value;
}

export function memorySearchTargetIdentity(target: MemorySearchTarget) {
  return createHash("sha256")
    .update(JSON.stringify(stableTargetValue(target)))
    .digest("hex");
}
