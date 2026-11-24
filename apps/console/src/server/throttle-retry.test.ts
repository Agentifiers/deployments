import { describe, expect, test } from "bun:test";
import { PlatformApiError } from "../errors.ts";
import { retryThrottled } from "./throttle-retry.ts";

function failingOnce(error: Error) {
  const calls: number[] = [];
  const task = async () => {
    calls.push(calls.length + 1);
    if (calls.length === 1) throw error;
    return "done";
  };
  return { calls, task };
}

describe("retryThrottled", () => {
  test("retries a throttled 429 after backing off", async () => {
    const sleeps: number[] = [];
    const { calls, task } = failingOnce(
      new PlatformApiError("listRuns", { code: "throttled", status: 429, title: "Throttled" }),
    );

    const result = await retryThrottled(
      task,
      async (milliseconds) => void sleeps.push(milliseconds),
    );

    expect(result).toBe("done");
    expect(calls).toEqual([1, 2]);
    expect(sleeps).toHaveLength(1);
  });

  test("throws a budget or upload-quota refusal on the first attempt without waiting", async () => {
    for (const code of ["budget_exhausted", "brain_upload_quota_exceeded"]) {
      const sleeps: number[] = [];
      const held = new PlatformApiError("retryRun", { code, status: 429, title: "Refused" });
      const { calls, task } = failingOnce(held);

      const outcome = await retryThrottled(
        task,
        async (milliseconds) => void sleeps.push(milliseconds),
      ).catch((error: unknown) => error);

      expect(outcome).toBe(held);
      expect(calls).toEqual([1]);
      expect(sleeps).toEqual([]);
    }
  });
});
