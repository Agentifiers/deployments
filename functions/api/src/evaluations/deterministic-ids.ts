import { createHash } from "node:crypto";
import { Ulid } from "@deployments-ai/db";
import { Schema } from "effect";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const decodeUlid = Schema.decodeUnknownSync(Ulid);

/**
 * A 26-character Crockford base32 identifier derived from the first 128 bits of
 * sha256(parts joined by NUL). The leading character is always 0-3, so the value is a valid
 * ULID/public ID, and the same parts always produce the same identifier.
 */
export function deterministicEvaluationId(...parts: readonly string[]): Ulid {
  let value = BigInt(
    `0x${createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32)}`,
  );
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = CROCKFORD[Number(value & 31n)]! + encoded;
    value >>= 5n;
  }
  return decodeUlid(encoded);
}
