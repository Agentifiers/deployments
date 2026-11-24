import { describe, expect, test } from "bun:test";
import { coherentLimits, parseTenantLimitDefaults, resolveEffectiveLimits } from "./limits.ts";

const DEFAULTS = {
  activeSandboxes: 8,
  apiRequestBurst: 40,
  apiRequestsPerSecond: 20,
  concurrentRuns: 8,
};

describe("tenant limits", () => {
  test("an override field wins and an absent field inherits the default", () => {
    expect(resolveEffectiveLimits(DEFAULTS, { concurrentRuns: 32 })).toEqual({
      activeSandboxes: { source: "default", value: 8 },
      apiRequestBurst: { source: "default", value: 40 },
      apiRequestsPerSecond: { source: "default", value: 20 },
      concurrentRuns: { source: "override", value: 32 },
    });
  });

  test("parses the OpenTofu-rendered defaults", () => {
    expect(
      parseTenantLimitDefaults({
        DEPLOYMENTS_AI_TENANT_LIMIT_DEFAULTS: JSON.stringify({
          active_sandboxes: 8,
          api_request_burst: 40,
          api_requests_per_second: 20,
          concurrent_runs: 8,
        }),
      }),
    ).toEqual(DEFAULTS);
  });

  test.each([
    [{}, "DEPLOYMENTS_AI_TENANT_LIMIT_DEFAULTS is required."],
    [
      {
        DEPLOYMENTS_AI_TENANT_LIMIT_DEFAULTS: JSON.stringify({
          active_sandboxes: 8,
          api_request_burst: 10,
          api_requests_per_second: 20,
          concurrent_runs: 8,
        }),
      },
      "apiRequestBurst must be at least apiRequestsPerSecond.",
    ],
    [
      {
        DEPLOYMENTS_AI_TENANT_LIMIT_DEFAULTS: JSON.stringify({
          active_sandboxes: 8,
          api_request_burst: 40,
          api_requests_per_second: 20,
        }),
      },
      "concurrentRuns must be an integer from 1 to 256.",
    ],
  ])("refuses to boot on invalid defaults %#", (environment, message) => {
    expect(() => parseTenantLimitDefaults(environment)).toThrow(message);
  });

  test("raises a burst below the rate to the rate and keeps a coherent pair", () => {
    expect([
      coherentLimits({ ...DEFAULTS, apiRequestBurst: 10, apiRequestsPerSecond: 50 }),
      coherentLimits(DEFAULTS),
    ]).toEqual([{ ...DEFAULTS, apiRequestBurst: 50, apiRequestsPerSecond: 50 }, DEFAULTS]);
  });
});
