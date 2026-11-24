import { describe, expect, test } from "bun:test";
import { type GovernanceOperation } from "@deployments-ai/governance";
import { PersistenceError } from "@deployments-ai/db";
import {
  ORGANIZATION_ID,
  PRINCIPAL_ID,
  OTHER_PRINCIPAL_ID,
  fixture,
  request,
} from "./governance-api.fixture.ts";

describe("governance API", () => {
  test("updates one retention class without resetting the others", async () => {
    const api = fixture();
    const response = await api.handler(
      request(`/v1/organizations/${ORGANIZATION_ID}/retention-policy`, {
        body: JSON.stringify({ messages: 30 }),
        headers: { "idempotency-key": "retention-update" },
        method: "PATCH",
      }),
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      artifacts: 365,
      audit: 2_555,
      messages: 30,
      version: 1,
    });
  });

  test("does not synthesize a retention policy for an erased organization", async () => {
    const api = fixture();
    api.markOrganizationErased();

    const response = await api.handler(
      request(`/v1/organizations/${ORGANIZATION_ID}/retention-policy`, {
        headers: { "x-test-platform": "true" },
      }),
    );

    expect(response?.status).toBe(410);
    expect(await response?.json()).toMatchObject({ code: "organization_erased" });
  });

  test("queues a deterministic tenant export and exposes its status route", async () => {
    const api = fixture();
    const created = await api.handler(
      request(`/v1/organizations/${ORGANIZATION_ID}/data-exports`, {
        headers: { "idempotency-key": "tenant-export" },
        method: "POST",
      }),
    );
    const body = (await created?.json()) as { id: string };

    expect(created?.status).toBe(202);
    expect(body.id).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u);
    expect(api.queued).toEqual([{ operationId: body.id, organizationId: ORGANIZATION_ID }]);
    expect(api.sequence).toEqual([
      "idempotency-start",
      "operation-prepared",
      "dispatch-ready-write:0",
      "idempotency-complete",
      "enqueue",
    ]);

    api.operations.set(body.id, {
      ...api.operations.get(body.id)!,
      completedAt: "2026-07-25T00:01:00.000Z",
      output: {
        bucket: "governance",
        key: "governance/export.jsonl",
        sha256: "a".repeat(64),
        sizeBytes: 42,
        versionId: "version-1",
      },
      status: "completed",
      updatedAt: "2026-07-25T00:01:00.000Z",
      version: 3,
    });
    const status = await api.handler(
      request(`/v1/organizations/${ORGANIZATION_ID}/data-exports/${body.id}`),
    );
    expect(await status?.json()).toMatchObject({
      output: {
        downloadUrl: "https://download.example.test/governance/export.jsonl",
        sha256: "a".repeat(64),
        sizeBytes: 42,
      },
      status: "completed",
    });
  });

  test("replays an existing export after its idempotency record expires", async () => {
    const api = fixture();
    const exportRequest = () =>
      request(`/v1/organizations/${ORGANIZATION_ID}/data-exports`, {
        headers: { "idempotency-key": "expired-export-replay" },
        method: "POST",
      });

    const first = await api.handler(exportRequest());
    const replay = await api.handler(exportRequest());
    const firstBody = (await first?.json()) as { id: string };
    const replayBody = (await replay?.json()) as { id: string };

    expect(first?.status).toBe(202);
    expect(replay?.status).toBe(202);
    expect(replayBody.id).toBe(firstBody.id);
    expect(api.operations.size).toBe(1);
    expect(api.sequence.filter((entry) => entry === "operation-prepared")).toHaveLength(1);
    expect(api.sequence.filter((entry) => entry.startsWith("dispatch-ready-write:"))).toHaveLength(
      1,
    );
    expect(api.queued).toHaveLength(2);
  });

  test("isolates deterministic operation IDs between principals", async () => {
    const api = fixture();
    const first = await api.handler(
      request(`/v1/organizations/${ORGANIZATION_ID}/data-exports`, {
        headers: {
          "idempotency-key": "shared-key",
          "x-test-principal": PRINCIPAL_ID,
        },
        method: "POST",
      }),
    );
    const second = await api.handler(
      request(`/v1/organizations/${ORGANIZATION_ID}/data-exports`, {
        headers: {
          "idempotency-key": "shared-key",
          "x-test-principal": OTHER_PRINCIPAL_ID,
        },
        method: "POST",
      }),
    );
    const firstBody = (await first?.json()) as { id: string };
    const secondBody = (await second?.json()) as { id: string };

    expect(first?.status).toBe(202);
    expect(second?.status).toBe(202);
    expect(firstBody.id).not.toBe(secondBody.id);
    expect(api.queued).toHaveLength(2);
  });

  test("returns separately version-pinned audit archive and manifest downloads", async () => {
    const api = fixture();
    const operationId = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
    api.operations.set(operationId, {
      archive: {
        bucket: "governance",
        key: "governance/audit-records.jsonl",
        sha256: "b".repeat(64),
        sizeBytes: 84,
        versionId: "archive-version",
      },
      completedAt: "2026-07-25T00:01:00.000Z",
      createdAt: "2026-07-25T00:00:00.000Z",
      id: operationId,
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
    } as unknown as GovernanceOperation);

    const response = await api.handler(
      request(`/v1/organizations/${ORGANIZATION_ID}/audit-exports/${operationId}`),
    );

    expect(await response?.json()).toMatchObject({
      output: {
        archiveDownloadUrl: "https://download.example.test/governance/audit-records.jsonl",
        archiveSha256: "b".repeat(64),
        archiveSizeBytes: 84,
        contentType: "application/json",
        downloadUrl: "https://download.example.test/governance/audit-manifest.json",
        sha256: "a".repeat(64),
      },
      status: "completed",
    });
  });

  test("requires explicit erasure confirmation and matching organization scope", async () => {
    const api = fixture();
    const invalid = await api.handler(
      request(`/v1/organizations/${ORGANIZATION_ID}/erasures`, {
        body: JSON.stringify({ confirmation: "DELETE" }),
        headers: { "idempotency-key": "erase" },
        method: "POST",
      }),
    );
    expect(invalid?.status).toBe(422);

    const unsupportedReason = await api.handler(
      request(`/v1/organizations/${ORGANIZATION_ID}/erasures`, {
        body: JSON.stringify({ confirmation: "ERASE", reason: "not persisted" }),
        headers: { "idempotency-key": "erase-with-reason" },
        method: "POST",
      }),
    );
    expect(unsupportedReason?.status).toBe(422);

    const mismatch = await api.handler(
      request(`/v1/organizations/${ORGANIZATION_ID}/retention-policy`, {
        headers: {
          "x-deployments-organization": "01ARZ3NDEKTSV4RRFFQ69G5FAX",
        },
      }),
    );
    expect(mismatch?.status).toBe(403);
    expect(await mismatch?.json()).toMatchObject({ code: "organization_scope_violation" });
  });

  test("maps durable idempotency conflicts to a problem response", async () => {
    const api = fixture(
      new PersistenceError(
        "conflict",
        "idempotency_conflict",
        "The idempotency key was already used for a different request.",
      ),
    );
    const response = await api.handler(
      request(`/v1/organizations/${ORGANIZATION_ID}/retention-policy`, {
        body: JSON.stringify({ messages: 30 }),
        headers: { "idempotency-key": "retention-update" },
        method: "PATCH",
      }),
    );

    expect(response?.status).toBe(409);
    expect(await response?.json()).toMatchObject({ code: "idempotency_conflict", status: 409 });
  });

  test("does not create tenant-scoped idempotency state for erasure requests", async () => {
    const api = fixture();
    const response = await api.handler(
      request(`/v1/organizations/${ORGANIZATION_ID}/erasures`, {
        body: JSON.stringify({ confirmation: "ERASE" }),
        headers: { "idempotency-key": "erase-without-recreation" },
        method: "POST",
      }),
    );

    expect(response?.status).toBe(202);
    expect(api.idempotencyExecutions()).toBe(0);
    expect(api.queued).toHaveLength(1);
  });

  test("requires an issuer-signed identity for erasure receipt continuity", async () => {
    const api = fixture();
    const response = await api.handler(
      request(`/v1/organizations/${ORGANIZATION_ID}/erasures`, {
        body: JSON.stringify({ confirmation: "ERASE" }),
        headers: {
          "idempotency-key": "opaque-erasure",
          "x-test-opaque": "true",
        },
        method: "POST",
      }),
    );

    expect(response?.status).toBe(403);
    expect(await response?.json()).toMatchObject({
      code: "erasure_requires_signed_identity",
    });
    expect(api.queued).toHaveLength(0);
    expect(api.operations.size).toBe(0);
  });

  test("accepts only one erasure requester for an organization", async () => {
    const api = fixture();
    const first = await api.handler(
      request(`/v1/organizations/${ORGANIZATION_ID}/erasures`, {
        body: JSON.stringify({ confirmation: "ERASE" }),
        headers: { "idempotency-key": "first-erasure" },
        method: "POST",
      }),
    );
    const second = await api.handler(
      request(`/v1/organizations/${ORGANIZATION_ID}/erasures`, {
        body: JSON.stringify({ confirmation: "ERASE" }),
        headers: {
          "idempotency-key": "second-erasure",
          "x-test-principal": OTHER_PRINCIPAL_ID,
        },
        method: "POST",
      }),
    );

    expect(first?.status).toBe(202);
    expect(second?.status).toBe(409);
    expect(await second?.json()).toMatchObject({
      code: "tenant_erasure_already_requested",
    });
    expect(api.operations.size).toBe(1);
    expect(api.queued).toHaveLength(1);
  });

  test("preserves requester access while tenant erasure recovery is incomplete", async () => {
    const api = fixture();
    const eraseRequest = () =>
      request(`/v1/organizations/${ORGANIZATION_ID}/erasures`, {
        body: JSON.stringify({ confirmation: "ERASE" }),
        headers: { "idempotency-key": "recover-erasure" },
        method: "POST",
      });
    const created = await api.handler(eraseRequest());
    const createdBody = (await created?.json()) as { id: string };
    api.operations.set(createdBody.id, {
      ...api.operations.get(createdBody.id)!,
      error: { code: "temporary_failure" },
      status: "failed",
      updatedAt: "2026-07-25T00:01:00.000Z",
      version: 3,
    });
    api.removeRequesterMembership();

    const status = await api.handler(
      request(`/v1/organizations/${ORGANIZATION_ID}/erasures/${createdBody.id}`),
    );
    expect(status?.status).toBe(200);
    expect(await status?.json()).toMatchObject({ id: createdBody.id, status: "failed" });

    const replay = await api.handler(eraseRequest());
    expect(replay?.status).toBe(202);
    expect(await replay?.json()).toMatchObject({ id: createdBody.id, status: "failed" });
    expect(api.queued).toHaveLength(2);

    const wrongPrincipal = await api.handler(
      request(`/v1/organizations/${ORGANIZATION_ID}/erasures/${createdBody.id}`, {
        headers: { "x-test-principal": OTHER_PRINCIPAL_ID },
      }),
    );
    expect(wrongPrincipal?.status).toBe(404);
  });

  test("blocks stale credentials after erasure while preserving receipt replay and polling", async () => {
    const api = fixture();
    const eraseRequest = () =>
      request(`/v1/organizations/${ORGANIZATION_ID}/erasures`, {
        body: JSON.stringify({ confirmation: "ERASE" }),
        headers: { "idempotency-key": "completed-erasure" },
        method: "POST",
      });
    const created = await api.handler(eraseRequest());
    const createdBody = (await created?.json()) as { id: string };
    const summary = {
      auditRootHash: "a".repeat(64),
      observability: {
        backupsExpireBy: "2026-08-24T00:01:00.000Z",
        clickhouseRowsDeleted: 7,
        icebergRowsDeleted: 5,
        physicalRemovalBy: "2026-07-28T00:01:00.000Z",
      },
      recordsDeleted: 12,
    };
    api.operations.set(createdBody.id, {
      ...api.operations.get(createdBody.id)!,
      completedAt: "2026-07-25T00:01:00.000Z",
      status: "completed",
      summary,
      updatedAt: "2026-07-25T00:01:00.000Z",
      version: 3,
    });
    api.markOrganizationErased();

    const blocked = await api.handler(
      request(`/v1/organizations/${ORGANIZATION_ID}/data-exports`, {
        headers: { "idempotency-key": "post-erasure-export" },
        method: "POST",
      }),
    );
    expect(blocked?.status).toBe(401);
    expect(await blocked?.json()).toMatchObject({ code: "unauthorized" });

    const replay = await api.handler(eraseRequest());
    expect(replay?.status).toBe(202);
    expect(await replay?.json()).toMatchObject({ id: createdBody.id, status: "completed" });

    const status = await api.handler(
      request(`/v1/organizations/${ORGANIZATION_ID}/erasures/${createdBody.id}`),
    );
    expect(status?.status).toBe(200);
    expect(await status?.json()).toMatchObject({
      id: createdBody.id,
      status: "completed",
      summary,
    });
    const wrongPrincipal = await api.handler(
      request(`/v1/organizations/${ORGANIZATION_ID}/erasures/${createdBody.id}`, {
        headers: { "x-test-principal": OTHER_PRINCIPAL_ID },
      }),
    );
    expect(wrongPrincipal?.status).toBe(404);
    expect(api.queued).toHaveLength(1);
  });
});
