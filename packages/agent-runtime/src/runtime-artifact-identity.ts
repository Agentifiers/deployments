import { Ulid, type Ulid as UlidValue } from "@deployments-ai/db";
import { Schema } from "effect";
import { createHash } from "node:crypto";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function hashSuffix(value: string) {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 10);
  let number = 0n;
  for (const byte of bytes) number = (number << 8n) | BigInt(byte);
  let encoded = "";
  for (let index = 0; index < 16; index += 1) {
    encoded = CROCKFORD[Number(number & 31n)]! + encoded;
    number >>= 5n;
  }
  return encoded;
}

export function runtimeArtifactId(runId: UlidValue, index: number, kind = "artifact"): UlidValue {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error("Runtime artifact index must be a non-negative safe integer.");
  }
  return Schema.decodeUnknownSync(Ulid)(
    `${runId.slice(0, 10)}${hashSuffix(`${runId}:${kind}:${index}`)}`,
  );
}
