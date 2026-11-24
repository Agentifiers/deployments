import { describe, expect, test } from "bun:test";
import { PlatformApiError } from "../errors.ts";
import { createHotPlaneQueue } from "./hot-plane-queue.ts";

const scope = { organizationId: "01ARZ3NDEKTSV4RRFFQ69G6006" };
const series = { from: "", interval: "hour", items: [], source: "traces", to: "" } as const;

function tooMany() {
  return new PlatformApiError("getObservabilityMetrics", {
    code: "observability_query_concurrency_exceeded",
    status: 429,
    title: "Observability query failed",
  });
}

describe("hot-plane queue", () => {
  test("never runs more than two observability calls at once", async () => {
    let active = 0;
    let peak = 0;
    // Every call yields before finishing, so ungated calls would all be in flight together.
    const call = (async () => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return series;
    }) as never;
    const hotPlane = createHotPlaneQueue("token", { call });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => hotPlane("getObservabilityMetrics", { scope })),
    );
    expect(results).toHaveLength(5);
    expect(peak).toBe(2);
  });

  test("retries a 429 after backing off, then returns the answer", async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    const call = (async () => {
      attempts += 1;
      if (attempts < 3) throw tooMany();
      return series;
    }) as never;
    const hotPlane = createHotPlaneQueue("token", {
      call,
      sleep: async (milliseconds) => void sleeps.push(milliseconds),
    });
    expect(hotPlane("getObservabilityMetrics", { scope })).resolves.toEqual(series);
    expect(attempts).toBe(3);
    expect(sleeps).toHaveLength(2);
    expect(sleeps[0]).toBeGreaterThanOrEqual(250);
    expect(sleeps[1]).toBeGreaterThanOrEqual(750);
  });

  test("gives up after three retries and passes other failures through untouched", async () => {
    let attempts = 0;
    const throttled = createHotPlaneQueue("token", {
      call: (async () => {
        attempts += 1;
        throw tooMany();
      }) as never,
      sleep: async () => undefined,
    });
    expect(throttled("getObservabilityMetrics", { scope })).rejects.toMatchObject({
      problem: { status: 429 },
    });
    expect(attempts).toBe(4);

    const unavailable = new PlatformApiError("getObservabilityMetrics", {
      code: "observability_unavailable",
      status: 503,
      title: "Observability unavailable",
    });
    let calls = 0;
    const disabled = createHotPlaneQueue("token", {
      call: (async () => {
        calls += 1;
        throw unavailable;
      }) as never,
      sleep: async () => undefined,
    });
    expect(disabled("getObservabilityMetrics", { scope })).rejects.toBe(unavailable);
    expect(calls).toBe(1);
  });
});
