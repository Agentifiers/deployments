import { Ulid } from "@deployments-ai/db";
import { Schema } from "effect";

/** The automation fire that submitted a run; its run idempotency key encodes exactly this. */
export interface AutomationRunReference {
  readonly fireId: Ulid;
  readonly id: Ulid;
  readonly kind: "heartbeat" | "schedule";
}

const isUlid = Schema.is(Ulid);

export function automationRunIdempotencyKey(reference: AutomationRunReference): string {
  return `${reference.kind}:${reference.id}:${reference.fireId}`;
}

export function parseAutomationRunIdempotencyKey(key: string): AutomationRunReference | undefined {
  const [kind, id, fireId, ...rest] = key.split(":");
  if (rest.length > 0 || (kind !== "heartbeat" && kind !== "schedule")) return undefined;
  return isUlid(id) && isUlid(fireId) ? { fireId, id, kind } : undefined;
}
