import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import puppeteer, { type LaunchOptions } from "puppeteer-core";
import { openGuardedPage } from "./chromium-page.ts";

const launches: LaunchOptions[] = [];
const launchRefused = new Error("launch refused by test");

afterEach(() => {
  mock.restore();
});

async function launchBudgetFor(timeoutMs: number) {
  launches.length = 0;
  spyOn(puppeteer, "launch").mockImplementation(async (options) => {
    launches.push(options ?? {});
    throw launchRefused;
  });
  const failure = await openGuardedPage({
    registerEmergencyCleanup: () => undefined,
    targets: { allowedOrigins: new Set(), anyPublicOrigin: false },
    timeoutMs,
    viewportSize: { height: 900, width: 1280 },
  }).catch((cause: unknown) => cause);
  expect(failure).toBe(launchRefused);
  expect(launches).toHaveLength(1);
  const { protocolTimeout, timeout } = launches[0]!;
  return { protocolTimeout, timeout };
}

describe("Chromium launch budget", () => {
  test("does not depend on the caller's page timeout", async () => {
    const shortPage = await launchBudgetFor(1_000);
    const longPage = await launchBudgetFor(60_000);

    expect(shortPage).toEqual(longPage);
    expect(shortPage.protocolTimeout).toBe(shortPage.timeout);
  });

  test("still lets one page-phase protocol call use the whole page timeout", async () => {
    const { protocolTimeout } = await launchBudgetFor(60_000);

    expect(protocolTimeout).toBeGreaterThanOrEqual(60_000);
  });
});
