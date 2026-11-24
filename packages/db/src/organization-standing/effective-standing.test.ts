import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { OrganizationStandingRecord } from "../records/organization-standing.ts";
import {
  TOOL_EGRESS_CLASSES,
  boundaryAdmitsEgress,
  boundaryAdmitsModel,
  egressAdmittedByEveryProfile,
} from "./data-boundary.ts";
import { ALL_FEATURES_ENABLED, effectiveStanding } from "./effective-standing.ts";
import {
  BILLING,
  INSTALL_DEFAULTS,
  OPEN_BOUNDARY,
  OPERATOR,
  ORGANIZATION_ID,
} from "./test-support.ts";

const AT = "2026-10-01T00:00:00.000Z";

const hold = {
  customerMessage: "An invoice is overdue.",
  key: "payment-overdue",
  placedAt: AT,
  placedBy: BILLING,
  reason: "payment",
};

function standingRecord(data: Record<string, unknown>) {
  return Schema.decodeUnknownSync(OrganizationStandingRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: AT,
        grants: {},
        organizationId: ORGANIZATION_ID,
        updatedAt: AT,
        version: 1,
        ...data,
      },
      itemType: "organization-standing" as const,
    }),
  );
}

describe("effective organization standing", () => {
  test("treats an organization without a standing record as active on install defaults", () => {
    expect(effectiveStanding(undefined, INSTALL_DEFAULTS)).toEqual({
      dataBoundary: OPEN_BOUNDARY,
      entitlements: { ...INSTALL_DEFAULTS, features: ALL_FEATURES_ENABLED },
      state: "active",
      version: 0,
    });
  });

  test("takes each field from the operator grant, then the service grant, then defaults", () => {
    const record = standingRecord({
      grants: {
        operator: {
          entitlements: {
            operatorFundedModelSpendCeiling: "unlimited",
            tenantLimits: { concurrentRuns: 64 },
          },
          grantedAt: AT,
          grantedBy: OPERATOR,
        },
        service: {
          entitlements: {
            operatorFundedModelSpendCeiling: { monthlyUsdMicros: 100_000_000 },
            tenantLimits: { activeSandboxes: 4, concurrentRuns: 16 },
          },
          grantedAt: AT,
          grantedBy: BILLING,
        },
      },
    });

    expect(effectiveStanding(record.data, INSTALL_DEFAULTS).entitlements).toEqual({
      features: ALL_FEATURES_ENABLED,
      operatorFundedModelSpendCeiling: "unlimited",
      tenantLimits: {
        activeSandboxes: 4,
        apiRequestBurst: 40,
        apiRequestsPerSecond: 20,
        concurrentRuns: 64,
      },
    });
  });

  test("a plan grant can turn a feature off, and an operator grant can turn it back on", () => {
    const grants = (operator?: { readonly sso?: boolean }) =>
      standingRecord({
        grants: {
          ...(operator
            ? {
                operator: {
                  entitlements: { features: operator },
                  grantedAt: AT,
                  grantedBy: OPERATOR,
                },
              }
            : {}),
          service: {
            entitlements: { features: { scim: false, sso: false } },
            grantedAt: AT,
            grantedBy: BILLING,
          },
        },
      }).data;

    expect(effectiveStanding(grants(), INSTALL_DEFAULTS).entitlements.features).toEqual({
      scim: false,
      sso: false,
    });
    expect(
      effectiveStanding(grants({ sso: true }), INSTALL_DEFAULTS).entitlements.features,
    ).toEqual({ scim: false, sso: true });
  });

  test("raises the merged burst to the merged rate when separate grants leave it below", () => {
    const record = standingRecord({
      grants: {
        operator: {
          entitlements: { tenantLimits: { apiRequestsPerSecond: 200 } },
          grantedAt: AT,
          grantedBy: OPERATOR,
        },
        service: {
          entitlements: { tenantLimits: { apiRequestBurst: 100, apiRequestsPerSecond: 50 } },
          grantedAt: AT,
          grantedBy: BILLING,
        },
      },
    });

    expect(effectiveStanding(record.data, INSTALL_DEFAULTS).entitlements.tenantLimits).toEqual({
      activeSandboxes: 1,
      apiRequestBurst: 200,
      apiRequestsPerSecond: 200,
      concurrentRuns: 2,
    });
  });
});

describe("organization data boundary", () => {
  const MODEL_IDS = [
    "openai/gpt-4o",
    "openrouter/x/y",
    "bedrock/anthropic.claude-sonnet-4-5-20250929-v1:0",
    "bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0",
  ];
  const phi = standingRecord({
    dataBoundary: { operatorNote: "BAA-2026-17", profile: "phi", setAt: AT, setBy: OPERATOR },
  }).data;

  test("an organization without a boundary is open and admits every egress class and model", () => {
    const { dataBoundary } = effectiveStanding(undefined, INSTALL_DEFAULTS);

    expect(dataBoundary.profile).toBe("open");
    expect(TOOL_EGRESS_CLASSES.map((egress) => boundaryAdmitsEgress(dataBoundary, egress))).toEqual(
      [true, true, true],
    );
    expect(MODEL_IDS.map((modelId) => boundaryAdmitsModel(dataBoundary, modelId))).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });

  test("a phi boundary admits only platform and configured egress and only Bedrock models", () => {
    const { dataBoundary } = effectiveStanding(phi, INSTALL_DEFAULTS);

    expect(dataBoundary.profile).toBe("phi");
    expect(TOOL_EGRESS_CLASSES.map((egress) => boundaryAdmitsEgress(dataBoundary, egress))).toEqual(
      [true, true, false],
    );
    expect(MODEL_IDS.map((modelId) => boundaryAdmitsModel(dataBoundary, modelId))).toEqual([
      false,
      false,
      true,
      true,
    ]);
  });

  test("a phi boundary refuses an empty, provider-only, or unnormalizable model id", () => {
    const { dataBoundary } = effectiveStanding(phi, INSTALL_DEFAULTS);

    expect(
      ["", "  ", "bedrock", "bedrock/", "bedrock/arn:aws:bedrock:us-east-1::x/y"].map((modelId) =>
        boundaryAdmitsModel(dataBoundary, modelId),
      ),
    ).toEqual([false, false, false, false, false]);
  });

  test("an open boundary admits an empty or unnormalizable id so model admission owns the error", () => {
    const { dataBoundary } = effectiveStanding(undefined, INSTALL_DEFAULTS);

    expect(
      ["", "  ", "bedrock/", "openrouter/", "bedrock/arn:aws:bedrock:us-east-1::x/y"].map(
        (modelId) => boundaryAdmitsModel(dataBoundary, modelId),
      ),
    ).toEqual([true, true, true, true, true]);
  });

  test("only public egress depends on the profile", () => {
    expect(TOOL_EGRESS_CLASSES.map(egressAdmittedByEveryProfile)).toEqual([true, true, false]);
  });

  test("rejects a data boundary that a service set", () => {
    expect(() =>
      standingRecord({
        dataBoundary: { operatorNote: "BAA-2026-17", profile: "phi", setAt: AT, setBy: BILLING },
      }),
    ).toThrow();
  });
});

describe("organization standing record", () => {
  test("rejects a suspension without holds, with a hold under another source's slot, or with a halt mode its holds do not derive", () => {
    const suspension = { haltMode: "drain", id: "01ARZ3NDEKTSV4RRFFQ69G5FB2", since: AT };
    const rejection =
      "A suspension holds at least one hold, each keyed by its source and key, and the halt mode its holds derive.";

    expect(() => standingRecord({ suspension: { ...suspension, holds: {} } })).toThrow(rejection);
    expect(() =>
      standingRecord({
        suspension: { ...suspension, holds: { "operator/payment-overdue": hold } },
      }),
    ).toThrow(rejection);
    expect(() =>
      standingRecord({
        suspension: {
          ...suspension,
          haltMode: "stop",
          holds: { "service:billing/payment-overdue": hold },
        },
      }),
    ).toThrow(rejection);
    expect(() =>
      standingRecord({
        suspension: {
          ...suspension,
          holds: {
            "operator/tos-review": {
              ...hold,
              key: "tos-review",
              placedBy: OPERATOR,
              reason: "abuse",
            },
            "service:billing/payment-overdue": hold,
          },
        },
      }),
    ).toThrow(rejection);
    expect(
      standingRecord({
        suspension: { ...suspension, holds: { "service:billing/payment-overdue": hold } },
      }).sk,
    ).toBe("ORGANIZATION-STANDING");
  });
});
