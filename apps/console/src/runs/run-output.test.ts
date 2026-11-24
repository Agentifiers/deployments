import { describe, expect, test } from "bun:test";
import { hidesRunOutput } from "./run-output.ts";

describe("hidesRunOutput", () => {
  test("the two conflicts without a final message hide the output", () => {
    expect(hidesRunOutput({ code: "run_not_completed", status: 409 })).toBe(true);
    expect(hidesRunOutput({ code: "run_message_unavailable", status: 409 })).toBe(true);
  });

  test("any 404 hides the output", () => {
    expect(hidesRunOutput({ code: "not_found", status: 404 })).toBe(true);
    expect(hidesRunOutput({ status: 404 })).toBe(true);
  });

  test("other problems still surface, including a message that fails its integrity check", () => {
    expect(hidesRunOutput({ code: "run_message_mismatch", status: 409 })).toBe(false);
    expect(hidesRunOutput({ code: "idempotency_conflict", status: 409 })).toBe(false);
    expect(hidesRunOutput({ code: "constructor", status: 409 })).toBe(false);
    expect(hidesRunOutput({ status: 409 })).toBe(false);
    expect(hidesRunOutput({ code: "insufficient_scope", status: 403 })).toBe(false);
    expect(hidesRunOutput({ code: "run_not_completed", status: 500 })).toBe(false);
  });
});
