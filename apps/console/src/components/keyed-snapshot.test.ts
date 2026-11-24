import { describe, expect, test } from "bun:test";
import { PlatformApiError } from "../errors.ts";
import { attemptAfterFailure, type KeyedAttempt } from "./keyed-attempt.ts";
import { snapshotFor, type KeyedSnapshot } from "./keyed-snapshot.ts";

const problem = (status: number, code: string) =>
  new PlatformApiError("archiveToolPolicy", { code, status, title: "T" });

function submit(
  attempt: KeyedAttempt,
  held: KeyedSnapshot<number> | undefined,
  live: number,
  error: unknown,
) {
  const sent = snapshotFor(held, attempt.key, attempt.state === "resend", live);
  return {
    attempt: attemptAfterFailure(attempt, error),
    held: sent,
    sent: sent.value,
  };
}

describe("snapshotFor", () => {
  test("a resend with the same key repeats the first value after the live value moved", () => {
    const first = snapshotFor(undefined, "key-1", false, 3);
    expect(snapshotFor(first, "key-1", true, 4)).toEqual({
      key: "key-1",
      value: 3,
    });
  });

  test("a new key after a rejection sends the refreshed value", () => {
    const first = snapshotFor(undefined, "key-1", false, 3);
    expect(snapshotFor(first, "key-2", false, 4)).toEqual({
      key: "key-2",
      value: 4,
    });
  });

  test("a 5xx then a version conflict under the same key sends the live version next", () => {
    const start: KeyedAttempt = { key: "k1", state: "fresh" };
    const lost = submit(start, undefined, 3, problem(500, "persistence_error"));
    const conflict = submit(lost.attempt, lost.held, 4, problem(409, "version_conflict"));
    const next = snapshotFor(
      conflict.held,
      conflict.attempt.key,
      conflict.attempt.state === "resend",
      4,
    );
    expect([lost.sent, conflict.sent, next.value]).toEqual([3, 3, 4]);
    expect(conflict.attempt).toEqual({ key: "k1", state: "reread" });
  });

  test("a 5xx then another 5xx keeps resending the first value", () => {
    const start: KeyedAttempt = { key: "k1", state: "fresh" };
    const first = submit(start, undefined, 3, problem(500, "persistence_error"));
    const second = submit(first.attempt, first.held, 4, problem(502, "bad_gateway"));
    const next = snapshotFor(second.held, second.attempt.key, second.attempt.state === "resend", 5);
    expect([first.sent, second.sent, next.value]).toEqual([3, 3, 3]);
  });

  test("a response lost after the request applied, then a 429, resends the applied value", () => {
    const start: KeyedAttempt = { key: "k1", state: "fresh" };
    const lost = submit(start, undefined, 3, problem(502, "bad_gateway"));
    const throttled = submit(lost.attempt, lost.held, 4, problem(429, "throttled"));
    const replay = snapshotFor(
      throttled.held,
      throttled.attempt.key,
      throttled.attempt.state === "resend",
      4,
    );
    expect([lost.sent, throttled.sent, replay]).toEqual([3, 3, { key: "k1", value: 3 }]);
  });
});
