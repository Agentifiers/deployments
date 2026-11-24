import { describe, expect, test } from "bun:test";
import { Exit, Schema } from "effect";
import { IdGenerationError, Ulid, makeIdGenerator } from "./ids.ts";

describe("IdGenerator", () => {
  test("generates schema-valid monotonic ULIDs", () => {
    const generator = makeIdGenerator();
    const ids = [generator.generate(), generator.generate(), generator.generate()];

    for (const id of ids) {
      expect(Exit.isSuccess(Schema.decodeUnknownExit(Ulid)(id))).toBe(true);
    }
    expect([...ids]).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("reports an invalid generator by throwing IdGenerationError", () => {
    const generator = makeIdGenerator(() => "not-a-ulid");

    expect(() => generator.generate()).toThrow(IdGenerationError);
  });

  test("rejects non-canonical lowercase ULIDs", () => {
    const exit = Schema.decodeUnknownExit(Ulid)("01arz3ndektsv4rrffq69g5fav");
    expect(Exit.isFailure(exit)).toBe(true);
  });
});
