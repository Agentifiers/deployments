import { describe, expect, it } from "bun:test";
import type { MemoryRecord, MemoryReviewItemRecord, MemorySpaceRecord } from "./index.ts";
import { createMockPlatformSdk, createPlatformSdk } from "./index.ts";

function jsonBody(init: RequestInit | undefined): unknown {
  const body = init?.body;
  if (typeof body !== "string") throw new Error("Expected a JSON string request body");
  return JSON.parse(body);
}

describe("platform SDK transport", () => {
  it("exposes memory supersession links", () => {
    const memory = {
      data: { supersededByMemoryId: "memory_next" },
      itemType: "memory",
    } as MemoryRecord;
    const review = {
      data: { supersedesMemoryId: "memory_previous" },
      itemType: "memory-review-item",
    } as MemoryReviewItemRecord;

    expect(memory.data.supersededByMemoryId).toBe("memory_next");
    expect(review.data.supersedesMemoryId).toBe("memory_previous");
  });

  it("represents disabled memory spaces returned by the platform", () => {
    const disabledSpace: MemorySpaceRecord = {
      data: {
        id: "space_disabled",
        kind: "shared",
        name: "Disabled space",
        status: "disabled",
        version: 1,
      },
      itemType: "memory-space",
    };

    expect(disabledSpace.data.status).toBe("disabled");
  });

  it("binds memory SDK requests to tenant context and canonical routes", async () => {
    const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: input instanceof Request ? input.url : String(input), init });
      return Response.json({ items: [] }, { headers: { "x-request-id": "req_memory" } });
    }) as unknown as typeof fetch;
    const sdk = createPlatformSdk({ baseUrl: "https://api.example.test", fetch: fetchImpl });
    const memory = sdk.memory({
      environmentId: "env_1",
      organizationId: "org_1",
      projectId: "prj_1",
    });
    const searchController = new AbortController();

    await memory.spaces.create(
      { name: "Operations", retentionDays: 90 },
      { idempotencyKey: "idem_space" },
    );
    await memory.memories.import(
      {
        data: [{ content: "Use the Tuesday change window.", scope: "organization" }],
        space: "space_1",
      },
      { idempotencyKey: "idem_import" },
    );
    await memory.memories.search(
      {
        memorySpaceIds: ["space_1"],
        query: "change window",
        topK: 5,
      },
      { signal: searchController.signal },
    );
    await memory.recall.active({ query: "change window", runId: "run_1", topK: 5 });
    await memory.reviews.resolve(
      "memory 1",
      "review 1",
      { decision: "approve", reason: "Verified by an operator" },
      { idempotencyKey: "idem_review" },
    );
    await memory.memories.delete("memory 1", {
      idempotencyKey: "idem_delete",
      reason: "Superseded guidance",
    });
    await memory.flushes.enqueue(
      { memoryMode: "workspace", memorySpaceId: "space_1", runId: "run_1" },
      { idempotencyKey: "idem_flush" },
    );
    await memory.flushes.get("run 1");
    await memory.grants.create(
      {
        agentDefinitionId: "agent_1",
        memorySpaceId: "space_1",
        permission: "read-write",
      },
      { idempotencyKey: "idem_grant" },
    );
    await memory.grants.update("grant 1", "read", { idempotencyKey: "idem_grant_update" });
    await memory.grants.revoke("grant 1", { idempotencyKey: "idem_grant_revoke" });
    await memory.grants.list({
      agentDefinitionId: "agent_1",
      cursor: "grant_cursor",
      limit: 10,
      memorySpaceId: "space_1",
      status: "all",
    });
    await memory.spaces.list({ cursor: "space_cursor", limit: 20 });
    await memory.memories.list({ cursor: "memory_cursor", limit: 30, space: "space_1" });
    await memory.memories.export("space_1", "json", { cursor: "export_cursor", limit: 40 });
    await memory.reviews.list("open", { cursor: "review_cursor", limit: 50 });
    await memory.policy.create(
      { scope: "environment", sensitivityMode: "standard" },
      { idempotencyKey: "idem_policy" },
    );
    await memory.policy.list({ cursor: "policy_cursor", limit: 60 });
    await memory.quality.get("2026-07-01T00:00:00.000Z", 1_000);
    await memory.evidence.strategySearch(
      {
        memorySpaceIds: ["space_1"],
        query: "change window",
        strategy: "hybrid-rerank-v1",
        topK: 20,
      },
      { signal: searchController.signal },
    );

    expect(requests.map((request) => [request.init?.method, request.url])).toEqual([
      ["POST", "https://api.example.test/v1/memory-spaces"],
      ["POST", "https://api.example.test/v1/memory/imports"],
      ["POST", "https://api.example.test/v1/memory/search"],
      ["POST", "https://api.example.test/v1/memory/active-recall"],
      ["POST", "https://api.example.test/v1/memory/memory%201/review-items/review%201"],
      ["POST", "https://api.example.test/v1/memory/memory%201/delete"],
      ["POST", "https://api.example.test/v1/memory/flushes"],
      ["GET", "https://api.example.test/v1/memory/flushes/run%201"],
      ["POST", "https://api.example.test/v1/memory-space-grants"],
      ["PATCH", "https://api.example.test/v1/memory-space-grants/grant%201"],
      ["DELETE", "https://api.example.test/v1/memory-space-grants/grant%201"],
      [
        "GET",
        "https://api.example.test/v1/memory-space-grants?agentDefinitionId=agent_1&cursor=grant_cursor&limit=10&memorySpaceId=space_1&status=all",
      ],
      ["GET", "https://api.example.test/v1/memory-spaces?cursor=space_cursor&limit=20"],
      ["GET", "https://api.example.test/v1/memory?cursor=memory_cursor&limit=30&space=space_1"],
      ["POST", "https://api.example.test/v1/memory/exports"],
      [
        "GET",
        "https://api.example.test/v1/memory/review-items?cursor=review_cursor&limit=50&status=open",
      ],
      ["POST", "https://api.example.test/v1/memory/policies"],
      ["GET", "https://api.example.test/v1/memory/policies?cursor=policy_cursor&limit=60"],
      [
        "GET",
        "https://api.example.test/v1/memory/quality?limit=1000&since=2026-07-01T00%3A00%3A00.000Z",
      ],
      ["POST", "https://api.example.test/v1/memory/evidence/strategy-search"],
    ]);
    expect(
      requests
        .filter((request) =>
          ["/v1/memory/search", "/v1/memory/evidence/strategy-search"].some((path) =>
            request.url.endsWith(path),
          ),
        )
        .every((request) => request.init?.signal === searchController.signal),
    ).toBe(true);
    const firstHeaders = new Headers(requests[0]?.init?.headers);
    expect(firstHeaders.get("x-deployments-organization")).toBe("org_1");
    expect(firstHeaders.get("x-deployments-project")).toBe("prj_1");
    expect(firstHeaders.get("x-deployments-environment")).toBe("env_1");
    expect(firstHeaders.get("idempotency-key")).toBe("idem_space");
    expect(jsonBody(requests[3]?.init)).toEqual({
      query: "change window",
      runId: "run_1",
      topK: 5,
    });
    expect(jsonBody(requests[4]?.init)).toEqual({
      decision: "approve",
      reason: "Verified by an operator",
    });
    expect(jsonBody(requests[5]?.init)).toEqual({
      reason: "Superseded guidance",
    });
    expect(new Headers(requests[5]?.init?.headers).get("idempotency-key")).toBe("idem_delete");
    expect(jsonBody(requests[6]?.init)).toEqual({
      memoryMode: "workspace",
      memorySpaceId: "space_1",
      runId: "run_1",
    });
    expect(jsonBody(requests[8]?.init)).toEqual({
      agentDefinitionId: "agent_1",
      memorySpaceId: "space_1",
      permission: "read-write",
    });
    expect(jsonBody(requests[9]?.init)).toEqual({ permission: "read" });
    expect(jsonBody(requests[14]?.init)).toEqual({
      cursor: "export_cursor",
      format: "json",
      limit: 40,
      space: "space_1",
    });
    expect(jsonBody(requests[16]?.init)).toEqual({
      scope: "environment",
      sensitivityMode: "standard",
    });
    expect(new Headers(requests[16]?.init?.headers).get("idempotency-key")).toBe("idem_policy");
    expect(jsonBody(requests.at(-1)?.init)).toEqual({
      memorySpaceIds: ["space_1"],
      query: "change window",
      strategy: "hybrid-rerank-v1",
      topK: 20,
    });
  });

  it("provides memory list, policy, review, search, and grant mock shapes", async () => {
    const sdk = createMockPlatformSdk({ now: () => new Date("2026-07-20T00:00:00.000Z") });
    const memory = sdk.memory({
      environmentId: "env_1",
      organizationId: "org_1",
      projectId: "prj_1",
    });

    const [
      createdGrant,
      listed,
      listedGrants,
      policies,
      reviews,
      searched,
      updatedGrant,
      revokedGrant,
    ] = await Promise.all([
      memory.grants.create({
        agentDefinitionId: "agent_1",
        memorySpaceId: "space_1",
        permission: "read-write",
      }),
      memory.memories.list(),
      memory.grants.list(),
      memory.policy.list(),
      memory.reviews.list(),
      memory.memories.search({ memorySpaceIds: ["space_1"], query: "change window" }),
      memory.grants.update("grant 1", "read"),
      memory.grants.revoke("grant 1"),
    ]);

    expect(listed.data.items).toHaveLength(2);
    expect(listedGrants.data.items).toHaveLength(2);
    expect(listedGrants.data.items[0]).toMatchObject({
      itemType: "memory-space-grant",
      data: { id: "grant_alpha" },
    });
    expect(listed.data.items[0]).toMatchObject({
      itemType: "memory",
      data: { id: "memory_alpha" },
    });
    expect(policies.data.items).toHaveLength(2);
    expect(reviews.data.items).toHaveLength(2);
    expect(reviews.data.items[0]).toMatchObject({
      itemType: "memory-review-item",
      data: { id: "review_alpha" },
    });
    expect(searched.data).toMatchObject({
      results: [
        { memory: { itemType: "memory", data: { id: "memory_alpha" } }, rank: 1 },
        { memory: { itemType: "memory", data: { id: "memory_beta" } }, rank: 2 },
      ],
    });
    expect(createdGrant.data).toMatchObject({
      itemType: "memory-space-grant",
      data: { agentDefinitionId: "agent_1", memorySpaceId: "space_1", permission: "read-write" },
    });
    expect(updatedGrant.data).toMatchObject({
      itemType: "memory-space-grant",
      data: { id: "grant 1", permission: "read" },
    });
    expect(revokedGrant.data).toMatchObject({
      itemType: "memory-space-grant",
      data: { id: "grant 1", revokedAt: "2026-07-20T00:00:00.000Z" },
    });
  });

  it("does not echo memory input and reports mock lifecycle states", async () => {
    const sdk = createMockPlatformSdk({ now: () => new Date("2026-07-20T00:00:00.000Z") });
    const memory = sdk.memory({
      environmentId: "env_1",
      organizationId: "org_1",
      projectId: "prj_1",
    });
    const imported = await memory.memories.import({
      data: [{ content: "Sensitive imported content", scope: "organization" }],
      space: "space_1",
    });
    const reviewed = await memory.reviews.resolve("memory_1", "review_1", {
      content: "Sensitive replacement content",
      decision: "edit",
    });
    const archived = await memory.memories.archive("memory_1");
    const deleted = await memory.memories.delete("memory_1");
    const restored = await memory.memories.restore("memory_1");

    expect(JSON.stringify(imported.data)).not.toContain("Sensitive imported content");
    expect(JSON.stringify(reviewed.data)).not.toContain("Sensitive replacement content");
    expect(archived.data.data.status).toBe("archived");
    expect(deleted.data.data.status).toBe("deleted");
    expect(restored.data.data.status).toBe("active");
  });

  it("preserves mock memory-space identity, input, and archive state", async () => {
    const sdk = createMockPlatformSdk({ now: () => new Date("2026-07-20T00:00:00.000Z") });
    const memory = sdk.memory({
      environmentId: "env_1",
      organizationId: "org_1",
      projectId: "prj_1",
    });

    const created = await memory.spaces.create({
      description: "Workspace operations memory",
      kind: "workspace",
      name: "Operations",
      retentionDays: 30,
      workspaceId: "workspace_1",
    });
    const detailed = await memory.spaces.get("space 1");
    const archived = await memory.spaces.archive("space 1");

    expect(created.data).toMatchObject({
      itemType: "memory-space",
      data: {
        description: "Workspace operations memory",
        id: "space_mock",
        kind: "workspace",
        name: "Operations",
        retentionDays: 30,
        status: "active",
        workspaceId: "workspace_1",
      },
    });
    expect(detailed.data).toMatchObject({ data: { id: "space 1", status: "active" } });
    expect(archived.data).toMatchObject({ data: { id: "space 1", status: "archived" } });
  });
});
