import { describe, expect, test } from "bun:test";
import { sleep } from "./sleep.ts";

async function elapsed(wait: Promise<void>): Promise<number> {
  const started = performance.now();
  await wait;
  return performance.now() - started;
}

describe("sleep", () => {
  test("waits the full time when nothing aborts it", async () => {
    expect(await elapsed(sleep(40, new AbortController().signal))).toBeGreaterThanOrEqual(35);
  });

  test("an abort ends the wait at once", async () => {
    const page = new AbortController();
    const wait = sleep(10_000, page.signal);
    page.abort();
    expect(await elapsed(wait)).toBeLessThan(1_000);
  });

  test("a signal that already aborted does not wait", async () => {
    const page = new AbortController();
    page.abort();
    expect(await elapsed(sleep(10_000, page.signal))).toBeLessThan(1_000);
  });
});
