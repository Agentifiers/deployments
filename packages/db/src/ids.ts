import { Schema } from "effect";
import { createHash } from "node:crypto";
import { monotonicFactory, type ULIDFactory } from "ulid";

export const Ulid = Schema.String.pipe(
  Schema.check(
    Schema.isULID({
      message: "Expected a 26-character ULID.",
    }),
    Schema.isPattern(/^[0-9A-HJKMNP-TV-Z]{26}$/, {
      message: "ULIDs must use canonical uppercase Crockford base32.",
    }),
  ),
  Schema.brand("Ulid"),
);
export type Ulid = typeof Ulid.Type;

export class IdGenerationError extends Schema.TaggedErrorClass<IdGenerationError>()(
  "IdGenerationError",
  {
    cause: Schema.Unknown,
    message: Schema.String,
  },
) {}

export interface IdGeneratorService {
  /** Returns a fresh monotonic ULID; throws {@link IdGenerationError} if the factory misbehaves. */
  readonly generate: () => Ulid;
}

const decodeUlid = Schema.decodeUnknownSync(Ulid);
const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function deterministicUlid(value: string): Ulid {
  let bits = BigInt(`0x${createHash("sha256").update(value).digest("hex").slice(0, 32)}`);
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = CROCKFORD_BASE32.charAt(Number(bits & 31n)) + encoded;
    bits >>= 5n;
  }
  return decodeUlid(encoded);
}

export function makeIdGenerator(factory: ULIDFactory = monotonicFactory()): IdGeneratorService {
  return {
    generate: () => {
      let id: string;
      try {
        id = factory();
      } catch (cause) {
        throw new IdGenerationError({ cause, message: "Failed to generate a platform ULID." });
      }
      try {
        return decodeUlid(id);
      } catch (cause) {
        throw new IdGenerationError({
          cause,
          message: "ULID generator returned an invalid identifier.",
        });
      }
    },
  };
}
