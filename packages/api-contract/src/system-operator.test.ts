import { describe, expect, test } from "bun:test";
import { makePublicOpenApiSpec } from "./openapi.ts";
import { SYSTEM_OPERATOR_API_ROUTES, SYSTEM_SERVICE_OPERATION_GRANTS } from "./system-operator.ts";
import { decodePublicResponse } from "./validation.ts";

describe("system operator contract", () => {
  test("publishes platform-administrator routes without tenant headers", () => {
    const publicOpenApiSpec = makePublicOpenApiSpec();
    for (const route of SYSTEM_OPERATOR_API_ROUTES) {
      expect(route).toMatchObject({
        authentication: "tenant-jwt",
        idempotency: "none",
        requiredAuthorization: "platform:admin",
        scopeHeaders: "none",
      });
      const path = route.path.replaceAll(/:(\w+)/gu, "{$1}");
      const operation = publicOpenApiSpec.paths[path]?.[route.method.toLowerCase()];
      expect(operation?.operationId).toBe(route.name);
      expect(operation?.security).toEqual([{ tenantJwt: [] }]);
    }
  });

  test("documents the SigV4 path and grant of each machine service operation", () => {
    const { paths } = makePublicOpenApiSpec();
    const organization = "/v1/system/organizations/{organizationId}";
    expect([
      paths[`${organization}/holds/{holdKey}`]?.put?.description,
      paths[`${organization}/standing/history`]?.get?.description,
      paths["/v1/system/organizations"]?.get?.description,
    ]).toEqual([
      "Requires platform:admin. A machine service whose principal holds organization-holds calls it with SigV4 at /v1/system/services/organizations/{organizationId}/holds/{holdKey}.",
      "Requires platform:admin. A machine service whose principal holds organization-read calls it with SigV4 at /v1/system/services/organizations/{organizationId}/standing/history.",
      "Requires platform:admin.",
    ]);
  });

  test("leaves the data boundary routes to operators, out of reach of machine services", () => {
    const { paths } = makePublicOpenApiSpec();
    const boundary = paths["/v1/system/organizations/{organizationId}/data-boundary"];
    expect([
      "setSystemOrganizationDataBoundary" in SYSTEM_SERVICE_OPERATION_GRANTS,
      "clearSystemOrganizationDataBoundary" in SYSTEM_SERVICE_OPERATION_GRANTS,
      boundary?.put?.description,
      boundary?.delete?.description,
    ]).toEqual([false, false, "Requires platform:admin.", "Requires platform:admin."]);
  });

  test("leaves organization limits to the entitlements routes", () => {
    const { paths } = makePublicOpenApiSpec();
    expect([
      paths["/v1/system/organizations/{organizationId}/limits"],
      Object.keys(paths["/v1/system/organizations/{organizationId}/entitlements"] ?? {}).toSorted(),
    ]).toEqual([undefined, ["delete", "put"]]);
  });

  test("rejects limit responses whose values leave the published bounds", () => {
    const limit = { source: "default", value: 8 } as const;
    const response = {
      effective: {
        activeSandboxes: limit,
        apiRequestBurst: { source: "default", value: 40 },
        apiRequestsPerSecond: { source: "override", value: 20 },
        concurrentRuns: limit,
      },
      organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    };
    expect(decodePublicResponse("getOrganizationLimits", response)).toEqual(response);
    expect(() =>
      decodePublicResponse("getOrganizationLimits", {
        ...response,
        effective: { ...response.effective, concurrentRuns: { source: "override", value: 0 } },
      }),
    ).toThrow("concurrentRuns must be an integer from 1 to 256.");
  });

  test("rejects component reports that leak a non-hex Lambda code digest", () => {
    const report = {
      checkedAt: "2026-10-01T00:00:00.000Z",
      ecsServices: [],
      lambdaFunctions: [
        {
          artifact: "platform-api",
          codeMatchesRelease: true,
          codeSha256: "a".repeat(64),
          functionName: "api",
          health: "healthy",
          lastModified: null,
          lastUpdateStatus: "Successful",
          state: "Active",
        },
      ],
    };
    expect(decodePublicResponse("getSystemComponents", report)).toEqual(report);
    expect(() =>
      decodePublicResponse("getSystemComponents", {
        ...report,
        lambdaFunctions: [{ ...report.lambdaFunctions[0], codeSha256: "base64+digest=" }],
      }),
    ).toThrow();
  });
});
