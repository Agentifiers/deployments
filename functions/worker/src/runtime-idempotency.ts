import type { Ulid } from "@deployments-ai/db";
import { createHash } from "node:crypto";

export function providerMutationRequestIdempotencyKey(runId: Ulid, logicalKey: string) {
  return `dai-${createHash("sha256").update(`${runId}\u0000${logicalKey}`).digest("hex").slice(0, 46)}`;
}

export function builtinMutationClaimIdempotencyKey(input: {
  readonly input?: Readonly<Record<string, unknown>>;
  readonly requestIdempotencyKey: string;
  readonly runId: Ulid;
  readonly toolName: string;
}) {
  const callerKey = input.input?.idempotencyKey;
  if (typeof callerKey !== "string" || !callerKey.trim()) return input.requestIdempotencyKey;
  return providerMutationRequestIdempotencyKey(
    input.runId,
    `${input.toolName}\u0000${callerKey.trim()}`,
  );
}
