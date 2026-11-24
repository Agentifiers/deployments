import { Ulid } from "@deployments-ai/db";
import { Schema } from "effect";
import { createHash } from "node:crypto";
import { AutomationError } from "./errors.ts";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function required(value: string, label: string, maximum: number) {
  const normalized = value.trim();
  if (!normalized) throw new AutomationError("invalid_request", `${label} is required.`);
  if (normalized.length > maximum) {
    throw new AutomationError("invalid_request", `${label} exceeds ${maximum} characters.`);
  }
  return normalized;
}

export function requiredUtf8(value: string, label: string, maximumBytes: number) {
  const normalized = required(value, label, maximumBytes);
  const hasControlCharacter = Array.from(normalized).some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (hasControlCharacter || new TextEncoder().encode(normalized).byteLength > maximumBytes) {
    throw new AutomationError(
      "invalid_request",
      `${label} must contain at most ${maximumBytes} UTF-8 bytes without control characters.`,
    );
  }
  return normalized;
}

export function deterministicId(seed: Ulid, discriminator: string): Ulid {
  const bytes = createHash("sha256").update(`${seed}:${discriminator}`).digest().subarray(0, 10);
  let number = 0n;
  for (const byte of bytes) number = (number << 8n) | BigInt(byte);
  let suffix = "";
  for (let index = 0; index < 16; index += 1) {
    suffix = CROCKFORD[Number(number & 31n)]! + suffix;
    number >>= 5n;
  }
  return Schema.decodeUnknownSync(Ulid)(`${seed.slice(0, 10)}${suffix}`);
}

export function automationCreationIdentity(
  scope: {
    readonly environmentId: Ulid;
    readonly organizationId: Ulid;
    readonly projectId: Ulid;
    readonly workspaceId?: Ulid;
  },
  kind: "heartbeat" | "schedule",
  idempotencyKey: string,
  command: Readonly<Record<string, unknown>>,
) {
  const normalizedKey = required(idempotencyKey, "Idempotency key", 512);
  const discriminator = JSON.stringify([
    scope.organizationId,
    scope.projectId,
    scope.workspaceId ?? null,
    kind,
    normalizedKey,
  ]);
  return {
    creationHash: createHash("sha256").update(JSON.stringify(command)).digest("hex"),
    id: deterministicId(scope.environmentId, discriminator),
  };
}
