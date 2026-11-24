import { createHash } from "node:crypto";

export function transactionToken(...parts: readonly string[]) {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 36);
}
