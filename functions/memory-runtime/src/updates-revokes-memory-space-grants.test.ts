import type { MemoryPlatform } from "@deployments-ai/memory";
import { describe, expect, it } from "bun:test";
import { handleMemoryApi, type MemoryApiEvent } from "./api.ts";
const ids = {
  environment: "01ARZ3NDEKTSV4RRFFQ69G5FA2",
  organization: "01ARZ3NDEKTSV4RRFFQ69G5FA5",
  project: "01ARZ3NDEKTSV4RRFFQ69G5FA6",
};

function event(path: string, method: string, body?: unknown): MemoryApiEvent {
  return {
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    rawPath: path,
    requestContext: {
      authorizer: {
        jwt: {
          claims: {
            environment_id: ids.environment,
            organization_id: ids.organization,
            project_id: ids.project,
            scope: "memory:admin memory:read memory:write",
          },
        },
      },
      http: { method, path },
      requestId: "request-1",
    },
  };
}

describe("memory API", () => {
  it("updates and revokes memory-space grants", async () => {
    const calls: unknown[] = [];
    const platform = {
      updateMemorySpaceGrant: async (
        _scope: Parameters<MemoryPlatform["updateMemorySpaceGrant"]>[0],
        grantId: Parameters<MemoryPlatform["updateMemorySpaceGrant"]>[1],
        input: Parameters<MemoryPlatform["updateMemorySpaceGrant"]>[2],
      ) => {
        calls.push({ grantId, input });
        return { data: { id: grantId, permission: input.permission } };
      },
      revokeMemorySpaceGrant: async (
        _scope: Parameters<MemoryPlatform["revokeMemorySpaceGrant"]>[0],
        grantId: Parameters<MemoryPlatform["revokeMemorySpaceGrant"]>[1],
        input: Parameters<MemoryPlatform["revokeMemorySpaceGrant"]>[2],
      ) => {
        calls.push({ grantId, input });
        return { data: { id: grantId, revokedAt: "now" } };
      },
    } as unknown as MemoryPlatform;
    const grantId = "01ARZ3NDEKTSV4RRFFQ69G5FAB";
    const updatedRequest = event(`/v1/memory-space-grants/${grantId}`, "PATCH", {
      permission: "read",
    });
    const revokedRequest = event(`/v1/memory-space-grants/${grantId}`, "DELETE");

    const updated = await handleMemoryApi(
      { ...updatedRequest, headers: { "idempotency-key": "grant-update" } },
      { platform },
    );
    const revoked = await handleMemoryApi(
      { ...revokedRequest, headers: { "idempotency-key": "grant-revoke" } },
      { platform },
    );

    expect(updated.statusCode).toBe(200);
    expect(revoked.statusCode).toBe(200);
    expect(calls).toEqual([
      { grantId, input: { idempotencyKey: "grant-update", permission: "read" } },
      { grantId, input: { idempotencyKey: "grant-revoke" } },
    ]);
  });

  it("leaves omitted policy recall settings for the platform default", async () => {
    let received: unknown;
    const platform = {
      upsertPolicy: async (
        _scope: Parameters<MemoryPlatform["upsertPolicy"]>[0],
        input: Parameters<MemoryPlatform["upsertPolicy"]>[1],
      ) => {
        received = input;
        return { id: "memory-policy-1" };
      },
    } as unknown as MemoryPlatform;

    const result = await handleMemoryApi(
      event("/v1/memory/policies", "POST", { retentionDays: 30 }),
      { platform },
    );

    expect(result.statusCode).toBe(201);
    expect(received).toEqual({ createOnly: true, retentionDays: 30 });
  });

  it("rejects non-number retention settings", async () => {
    let called = false;
    const platform = {
      createMemorySpace: async () => {
        called = true;
      },
      upsertPolicy: async () => {
        called = true;
      },
    } as unknown as MemoryPlatform;

    const space = await handleMemoryApi(
      event("/v1/memory-spaces", "POST", { name: "Ops", retentionDays: "30" }),
      { platform },
    );
    const policy = await handleMemoryApi(
      event("/v1/memory/policies", "POST", { retentionDays: "30" }),
      { platform },
    );

    expect(space.statusCode).toBe(400);
    expect(policy.statusCode).toBe(400);
    expect(JSON.parse(space.body ?? "{}")).toMatchObject({ code: "invalid_request" });
    expect(JSON.parse(policy.body ?? "{}")).toMatchObject({ code: "invalid_request" });
    expect(called).toBe(false);
  });

  it("rejects malformed optional policy identifiers", async () => {
    let called = false;
    const platform = {
      upsertPolicy: async () => {
        called = true;
      },
    } as unknown as MemoryPlatform;

    const invalidId = await handleMemoryApi(
      event("/v1/memory/policies", "POST", { id: 123, retentionDays: 30 }),
      { platform },
    );
    const invalidWorkspace = await handleMemoryApi(
      event("/v1/memory/policies", "POST", {
        retentionDays: 30,
        scope: "workspace",
        workspaceId: 123,
      }),
      { platform },
    );

    expect(invalidId.statusCode).toBe(400);
    expect(invalidWorkspace.statusCode).toBe(400);
    expect(JSON.parse(invalidId.body ?? "{}")).toMatchObject({ code: "invalid_id" });
    expect(JSON.parse(invalidWorkspace.body ?? "{}")).toMatchObject({ code: "invalid_id" });
    expect(called).toBe(false);
  });

  it("rejects array-valued memory policy processing configuration", async () => {
    const result = await handleMemoryApi(
      event("/v1/memory/policies", "POST", { processingConfig: [] }),
      { platform: {} as MemoryPlatform },
    );

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body ?? "{}")).toMatchObject({ code: "invalid_request" });
  });
});
