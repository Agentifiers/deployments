import { describe, expect, spyOn, test } from "bun:test";
import { operatorAccessGrant } from "@deployments-ai/db/operator-access-testing";
import { ORGANIZATION_ID, PRINCIPAL_ID, fixture, request } from "./governance-api.fixture.ts";

describe("governance API", () => {
  test("lists operation history with the get-by-id projection, filters, and pagination", async () => {
    const api = fixture();
    const auditExportId = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
    api.operations.set(auditExportId, {
      archive: {
        bucket: "governance",
        key: "governance/audit-records.jsonl",
        sha256: "b".repeat(64),
        sizeBytes: 84,
        versionId: "archive-version",
      },
      completedAt: "2026-07-25T00:01:00.000Z",
      createdAt: "2026-07-25T00:00:00.000Z",
      id: auditExportId,
      idempotencyKey: "audit-export",
      kind: "audit-export",
      organizationId: ORGANIZATION_ID,
      output: {
        bucket: "governance",
        key: "governance/audit-manifest.json",
        sha256: "a".repeat(64),
        sizeBytes: 42,
        versionId: "manifest-version",
      },
      requestedByPrincipalId: PRINCIPAL_ID,
      status: "completed",
      updatedAt: "2026-07-25T00:01:00.000Z",
      version: 3,
    });
    const created = await api.handler(
      request(`/v1/organizations/${ORGANIZATION_ID}/data-exports`, {
        headers: { "idempotency-key": "history-export" },
        method: "POST",
      }),
    );
    expect(created?.status).toBe(202);
    const exportId = ((await created!.json()) as { id: string }).id;
    api.operations.set(exportId, {
      ...api.operations.get(exportId)!,
      createdAt: "2026-07-25T00:02:00.000Z",
    });
    const historyPath = `/v1/organizations/${ORGANIZATION_ID}/governance-operations`;

    const all = await api.handler(
      request(`${historyPath}`, { headers: { "x-test-scopes": "governance:read" } }),
    );
    expect(all?.status).toBe(200);
    const allBody = (await all?.json()) as {
      readonly items: readonly Readonly<Record<string, unknown>>[];
    };
    expect(allBody.items.map((item) => [item.id, item.kind])).toEqual([
      [exportId, "tenant-export"],
      [auditExportId, "audit-export"],
    ]);
    const single = await api.handler(
      request(`/v1/organizations/${ORGANIZATION_ID}/audit-exports/${auditExportId}`),
    );
    expect(allBody.items[1]).toEqual((await single?.json()) as Record<string, unknown>);

    const filtered = await api.handler(
      request(`${historyPath}?kind=audit-export&status=completed&limit=1&cursor=page-two`),
    );
    expect(filtered?.status).toBe(200);
    expect(api.listQueries.at(-1)).toEqual({
      cursor: "page-two",
      kind: "audit-export",
      limit: 1,
      organizationId: ORGANIZATION_ID,
      status: "completed",
    });
    const paged = await api.handler(request(`${historyPath}?limit=1`));
    expect(await paged?.json()).toMatchObject({
      items: [{ id: exportId }],
      nextCursor: "next-page",
    });

    for (const query of ["kind=retention", "status=done", "limit=0", "limit=101", "limit=two"]) {
      const invalid = await api.handler(request(`${historyPath}?${query}`));
      expect(invalid?.status).toBe(400);
    }
  });

  test("enforces governance read scope, organization scope, and erasure on history", async () => {
    const api = fixture();
    const historyPath = `/v1/organizations/${ORGANIZATION_ID}/governance-operations`;

    const unscoped = await api.handler(
      request(historyPath, { headers: { "x-test-scopes": "audit:read" } }),
    );
    expect(unscoped?.status).toBe(403);
    expect(await unscoped?.json()).toMatchObject({ code: "insufficient_scope" });
    const mismatched = await api.handler(
      request(historyPath, {
        headers: { "x-deployments-organization": "01ARZ3NDEKTSV4RRFFQ69G5FAT" },
      }),
    );
    expect(mismatched?.status).toBe(403);
    expect(await api.handler(request(historyPath, { method: "POST", body: "{}" }))).toBeUndefined();
    expect(await api.handler(request(`${historyPath}/${PRINCIPAL_ID}`))).toBeUndefined();
    expect(api.listQueries).toEqual([]);

    api.markOrganizationErased();
    const erased = await api.handler(
      request(historyPath, { headers: { "x-test-platform": "true" } }),
    );
    expect(erased?.status).toBe(410);
    expect(await erased?.json()).toMatchObject({ code: "organization_erased" });
  });

  test("logs one bounded cause for an unexpected history failure and none for caller errors", async () => {
    const api = fixture();
    const historyPath = `/v1/organizations/${ORGANIZATION_ID}/governance-operations`;
    spyOn(api.service, "listOperations").mockImplementation(async () => {
      throw Object.assign(
        new Error("User is not authorized to perform: dynamodb:BatchGetItem on table control"),
        { name: "AccessDeniedException" },
      );
    });
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      const denied = await api.handler(
        request(historyPath, { headers: { "x-test-scopes": "audit:read" } }),
      );
      expect(denied?.status).toBe(403);
      const failed = await api.handler(request(historyPath));
      expect(failed?.status).toBe(500);
      expect(await failed?.json()).toEqual({
        code: "internal_error",
        requestId: "req_governance",
        status: 500,
        title: "Internal server error",
        type: "https://docs.deployments.ai/errors/internal-error",
      });
      expect(consoleError.mock.calls).toEqual([
        [
          "Governance API request failed.",
          {
            code: "internal_error",
            error: "User is not authorized to perform: dynamodb:BatchGetItem on table control",
            errorType: "AccessDeniedException",
            requestId: "req_governance",
            route: "GET /v1/organizations/{organizationId}/governance-operations",
          },
        ],
      ]);
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("governance organization roles", () => {
  test("gates governance mutations by organization role and keeps API keys on scopes", async () => {
    const mutations = {
      "audit export": { method: "POST", path: "audit-exports" },
      "data export": { method: "POST", path: "data-exports" },
      erasure: {
        body: JSON.stringify({ confirmation: "ERASE" }),
        method: "POST",
        path: "erasures",
      },
      "retention update": {
        body: JSON.stringify({ messages: 30 }),
        method: "PATCH",
        path: "retention-policy",
      },
    } as const;
    const callers = {
      admin: { "x-test-role": "admin" },
      "api-key": { "x-test-opaque": "true" },
      billing: { "x-test-role": "billing" },
      member: { "x-test-role": "member" },
      owner: { "x-test-role": "owner" },
      "platform-admin": { "x-test-platform": "true" },
      viewer: { "x-test-role": "viewer" },
    } as const;
    const observed: Record<string, Record<string, number | undefined>> = {};
    for (const [caller, headers] of Object.entries(callers)) {
      observed[caller] = {};
      for (const [name, mutation] of Object.entries(mutations)) {
        const response = await fixture().handler(
          request(`/v1/organizations/${ORGANIZATION_ID}/${mutation.path}`, {
            ...("body" in mutation ? { body: mutation.body } : {}),
            headers: { ...headers, "idempotency-key": `${caller}-${name}` },
            method: mutation.method,
          }),
        );
        observed[caller][name] = response?.status;
      }
    }
    const mutationStatus = { "audit export": 202, "data export": 202, "retention update": 200 };
    const roleDenied = {
      "audit export": 403,
      "data export": 403,
      erasure: 403,
      "retention update": 403,
    };
    expect(observed).toEqual({
      admin: { ...mutationStatus, erasure: 403 },
      // API keys keep scope-only access; erasure still requires an issuer-signed identity.
      "api-key": { ...mutationStatus, erasure: 403 },
      billing: roleDenied,
      member: roleDenied,
      owner: { ...mutationStatus, erasure: 202 },
      "platform-admin": { ...mutationStatus, erasure: 202 },
      viewer: roleDenied,
    });
  });

  test("reports the missing role rather than the missing scope", async () => {
    const response = await fixture().handler(
      request(`/v1/organizations/${ORGANIZATION_ID}/erasures`, {
        body: JSON.stringify({ confirmation: "ERASE" }),
        headers: { "idempotency-key": "admin-erasure", "x-test-role": "admin" },
        method: "POST",
      }),
    );
    expect(response?.status).toBe(403);
    expect(await response?.json()).toMatchObject({ code: "insufficient_role" });
  });

  test("hands the operator access grant to every governance write an administrator makes under it", async () => {
    const grantId = operatorAccessGrant(ORGANIZATION_ID).grantId;
    const api = fixture();
    const updates = spyOn(api.service, "updateRetentionPolicy");
    const erasures = spyOn(api.service, "requestOperation");
    const headers = { "x-test-platform": "true" };
    const path = (resource: string) => `/v1/organizations/${ORGANIZATION_ID}/${resource}`;

    await api.handler(
      request(path("retention-policy"), {
        body: JSON.stringify({ messages: 30 }),
        headers: { ...headers, "idempotency-key": "policy" },
        method: "PATCH",
      }),
    );
    await api.handler(
      request(path("erasures"), {
        body: JSON.stringify({ confirmation: "ERASE" }),
        headers: { ...headers, "idempotency-key": "erase" },
        method: "POST",
      }),
    );

    await api.handler(
      request(path("data-exports"), {
        headers: { ...headers, "idempotency-key": "export" },
        method: "POST",
      }),
    );

    expect(api.dispatchGrants).toEqual([grantId]);
    expect(updates.mock.calls[0]?.[0]).toMatchObject({ operatorAccessGrantId: grantId });
    expect(erasures.mock.calls[0]?.[0]).toMatchObject({ operatorAccessGrantId: grantId });

    const member = fixture();
    await member.handler(
      request(path("data-exports"), { headers: { "idempotency-key": "export" }, method: "POST" }),
    );
    expect(member.dispatchGrants).toEqual([undefined]);
  });
});
