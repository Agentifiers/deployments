import { describe, expect, test } from "bun:test";
import { makeHotPlaneErasureClient } from "./observability-erasure-hot-plane.ts";

const REQUEST = {
  drainAnchorAt: "2026-10-01T11:45:00.000Z",
  operationId: "01BX5ZZKBKACTAV9WEVGEMMVRZ",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  timeoutMs: 1_000,
};

function client(status: number, body: unknown) {
  const requests: { readonly body: unknown; readonly url: string }[] = [];
  const hotPlane = makeHotPlaneErasureClient({
    baseUrl: "http://hot-plane.observability.internal:3000",
    fetch: (async (url: string, init: RequestInit) => {
      if (typeof init.body !== "string")
        throw new TypeError("Expected a JSON string request body.");
      requests.push({ body: JSON.parse(init.body), url });
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch,
    serviceToken: async () => "token",
  });
  return { erase: () => hotPlane.erase(REQUEST), requests };
}

describe("hot-plane erasure client", () => {
  test("sends the drain anchor so the hot plane can prove its writer caught up", async () => {
    const { erase, requests } = client(202, { reason: "writer_catching_up", status: "pending" });

    expect(await erase()).toEqual({ reason: "writer_catching_up", status: "pending" });
    expect(requests).toEqual([
      {
        body: {
          drainAnchorAt: REQUEST.drainAnchorAt,
          operationId: REQUEST.operationId,
          organizationId: REQUEST.organizationId,
        },
        url: "http://hot-plane.observability.internal:3000/internal/organization-erasures",
      },
    ]);
  });

  test("decodes a running mutation with its remaining rows", async () => {
    const { erase } = client(202, {
      reason: "mutation_running",
      remainingRows: 4,
      status: "pending",
    });

    expect(await erase()).toEqual({
      reason: "mutation_running",
      remainingRows: 4,
      status: "pending",
    });
  });

  test("treats a replaying hot plane as a writer still catching up", async () => {
    const { erase } = client(503, { code: "observability_initializing" });

    expect(await erase()).toEqual({ reason: "writer_catching_up", status: "pending" });
  });

  test.each([
    ["no reason", { remainingRows: 1, status: "pending" }],
    ["an unknown reason", { reason: "waiting", status: "pending" }],
    [
      "a running mutation without remaining rows",
      { reason: "mutation_running", status: "pending" },
    ],
    [
      "a catching-up writer with extra fields",
      { reason: "writer_catching_up", remainingRows: 0, status: "pending" },
    ],
    ["a non-object body", ["pending"]],
  ])("rejects a pending response with %s", async (_label, body) => {
    const { erase } = client(202, body);

    expect(erase()).rejects.toThrow("Hot-plane organization erasure returned");
  });
});
