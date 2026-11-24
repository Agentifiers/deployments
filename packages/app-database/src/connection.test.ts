import { describe, expect, test } from "bun:test";
import { DatabaseError } from "pg";
import { connectAwaitingResume } from "./connection.ts";

async function outcome(waitMs: number, failures: readonly Error[]) {
  let attempts = 0;
  const result = await connectAwaitingResume(waitMs, async () => {
    const failure = failures[attempts];
    attempts += 1;
    if (failure !== undefined) throw failure;
    return "client";
  }).then(
    (client) => ({ client }),
    (error: unknown) => ({ error }),
  );
  return { attempts, ...result };
}

describe("connectAwaitingResume", () => {
  test("a login that fails twice while the database resumes connects on the third attempt", async () => {
    const starting = Object.assign(
      new DatabaseError("the database system is starting up", 0, "error"),
      { code: "57P03" },
    );
    expect(await outcome(60_000, [new Error("timeout expired"), starting])).toEqual({
      attempts: 3,
      client: "client",
    });
  });

  test("without a wait the first unavailable answer reaches the caller", async () => {
    const timeout = new Error("timeout expired");
    expect(await outcome(0, [timeout, timeout])).toEqual({ attempts: 1, error: timeout });
  });

  test("a refusal that waiting cannot fix is not retried", async () => {
    const refusal = Object.assign(
      new DatabaseError('PAM authentication failed for user "app_x_viewer"', 0, "error"),
      { code: "28P01" },
    );
    expect(await outcome(60_000, [refusal, refusal])).toEqual({ attempts: 1, error: refusal });
  });

  test("no attempt starts once the next retry would end past the wait", async () => {
    const refused = new Error("connect ECONNREFUSED 10.0.1.5:5432");
    expect(await outcome(1_000, [refused, refused, refused, refused])).toEqual({
      attempts: 2,
      error: refused,
    });
  });
});
