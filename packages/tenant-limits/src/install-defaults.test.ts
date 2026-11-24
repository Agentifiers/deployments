import { describe, expect, test } from "bun:test";
import { parseInstallDefaultEntitlements } from "./install-defaults.ts";

const TENANT_LIMIT_DEFAULTS = JSON.stringify({
  active_sandboxes: 1,
  api_request_burst: 40,
  api_requests_per_second: 20,
  concurrent_runs: 2,
});

describe("install default entitlements", () => {
  test("leaves operator-funded model spend unlimited when the install sets no ceiling", () => {
    expect(
      parseInstallDefaultEntitlements({
        DEPLOYMENTS_AI_TENANT_LIMIT_DEFAULTS: TENANT_LIMIT_DEFAULTS,
      }),
    ).toEqual({
      operatorFundedModelSpendCeiling: "unlimited",
      tenantLimits: {
        activeSandboxes: 1,
        apiRequestBurst: 40,
        apiRequestsPerSecond: 20,
        concurrentRuns: 2,
      },
    });
  });

  test("reads the install's monthly ceiling in USD micros", () => {
    expect(
      parseInstallDefaultEntitlements({
        DEPLOYMENTS_AI_OPERATOR_FUNDED_MODEL_SPEND_CEILING_USD_MICROS: "5000000",
        DEPLOYMENTS_AI_TENANT_LIMIT_DEFAULTS: TENANT_LIMIT_DEFAULTS,
      }).operatorFundedModelSpendCeiling,
    ).toEqual({ monthlyUsdMicros: 5_000_000 });
  });

  test.each(["-1", "5.5", "5e6", "9007199254740993"])("refuses a ceiling of %p", (ceiling) => {
    expect(() =>
      parseInstallDefaultEntitlements({
        DEPLOYMENTS_AI_OPERATOR_FUNDED_MODEL_SPEND_CEILING_USD_MICROS: ceiling,
        DEPLOYMENTS_AI_TENANT_LIMIT_DEFAULTS: TENANT_LIMIT_DEFAULTS,
      }),
    ).toThrow(
      "DEPLOYMENTS_AI_OPERATOR_FUNDED_MODEL_SPEND_CEILING_USD_MICROS must be a whole number of USD micros.",
    );
  });
});
