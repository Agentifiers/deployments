import { describe, expect, test } from "bun:test";
import type { ModelGatewayRunLease } from "@deployments-ai/db";
import { makeRunActivityCheck, RunStateUnavailableError } from "./run-activity.ts";
import { LEASE_OWNER, RUN_ID, THREAD_ID, runLease } from "./test-support.ts";

const claims = { leaseOwner: LEASE_OWNER, runId: RUN_ID, threadId: THREAD_ID };

function harness(lease: () => Promise<ModelGatewayRunLease | undefined>) {
  const clock = { now: Date.parse("2026-10-02T12:00:00.000Z") };
  let reads = 0;
  const check = makeRunActivityCheck({
    now: () => clock.now,
    reader: {
      getThreadExecutionLease: async (threadId) => {
        expect(threadId).toBe(THREAD_ID);
        reads += 1;
        return lease();
      },
    },
  });
  return { check, clock, reads: () => reads };
}

describe("run activity check", () => {
  test("concurrent lookups for one run share a single lease read", async () => {
    let release!: (value: ModelGatewayRunLease) => void;
    const pending = new Promise<ModelGatewayRunLease>((resolve) => (release = resolve));
    const { check, clock, reads } = harness(() => pending);
    const lookups = Promise.all([check(claims), check(claims), check(claims)]);
    release(runLease({ expiresAt: new Date(clock.now + 60_000).toISOString() }));
    expect(await lookups).toEqual([true, true, true]);
    expect(reads()).toBe(1);
  });

  test("separate runs and owners are cached separately", async () => {
    const { check, clock, reads } = harness(async () =>
      runLease({ expiresAt: "2026-10-02T12:01:00.000Z" }),
    );
    expect(await check(claims)).toBe(true);
    expect(await check({ ...claims, leaseOwner: "worker-z" })).toBe(false);
    expect(await check({ ...claims, runId: "01ARZ3NDEKTSV4RRFFQ69G0099" })).toBe(false);
    clock.now += 1_000;
    expect(await check({ ...claims, leaseOwner: "worker-z" })).toBe(false);
    expect(reads()).toBe(3);
  });

  test("read failures surface as RunStateUnavailableError and are not cached", async () => {
    let fail = true;
    const { check, clock, reads } = harness(async () => {
      if (fail) throw new Error("throttled");
      return runLease({ expiresAt: new Date(clock.now + 60_000).toISOString() });
    });
    expect(check(claims)).rejects.toBeInstanceOf(RunStateUnavailableError);
    fail = false;
    expect(await check(claims)).toBe(true);
    expect(reads()).toBe(2);
  });
});
