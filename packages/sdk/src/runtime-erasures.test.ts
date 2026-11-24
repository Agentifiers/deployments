import { describe, expect, test } from "bun:test";
import { createPlatformSdk } from "./index.ts";

function erasure(status: string) {
  return {
    erasure: {
      counts: {
        automationsArchived: 0,
        ingressRecordsDeleted: 0,
        memoriesErased: 0,
        objectsStaged: 0,
        recordsDeleted: 0,
        runsCanceled: 0,
        streamsDeleted: 0,
        threadsErased: 0,
        threadsPlanned: 1,
      },
      createdAt: "2026-10-07T12:00:00.000Z",
      environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
      id: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
      kind: "end-user",
      phase: "canonical",
      status,
      updatedAt: "2026-10-07T12:00:00.000Z",
    },
  };
}

function recordingSdk(statuses: readonly string[]) {
  const requests: { body?: unknown; method: string; url: string }[] = [];
  const pending = [...statuses];
  const sdk = createPlatformSdk({
    apiKey: "platform-api-key",
    baseUrl: "https://api.example.test",
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
        method: String(init?.method),
        url: input instanceof Request ? input.url : String(input),
      });
      return Response.json(erasure(pending.shift() ?? "completed"));
    }) as unknown as typeof fetch,
  });
  return {
    requests,
    runtime: sdk.runtime({ environmentId: "env", organizationId: "org", projectId: "prj" }),
  };
}

describe("runtime SDK erasures", () => {
  test("binds thread and end-user erasure to their routes", async () => {
    const { requests, runtime } = recordingSdk([]);

    await runtime.threads.erase("thread 1");
    await runtime.threads.getErasure("thread 1", "erasure 1");
    await runtime.endUsers.erase({ endUserId: "cus_8f2a91" });
    await runtime.endUsers.getErasure("erasure 2");

    expect(requests).toEqual([
      { method: "POST", url: "https://api.example.test/v1/threads/thread%201/erasures" },
      {
        method: "GET",
        url: "https://api.example.test/v1/threads/thread%201/erasures/erasure%201",
      },
      {
        body: { endUserId: "cus_8f2a91" },
        method: "POST",
        url: "https://api.example.test/v1/end-users/erasures",
      },
      { method: "GET", url: "https://api.example.test/v1/end-users/erasures/erasure%202" },
    ]);
  });

  test("waitForErasure polls until the erasure settles", async () => {
    const { requests, runtime } = recordingSdk(["pending", "running", "completed"]);

    const settled = await runtime.endUsers.waitForErasure("erasure 2", { intervalMs: 1 });

    expect(settled.data.erasure.status).toBe("completed");
    expect(requests).toHaveLength(3);
  });

  test("waitForErasure gives up at its timeout", async () => {
    const { runtime } = recordingSdk(["running", "running", "running", "running"]);

    expect(
      runtime.threads.waitForErasure("thread 1", "erasure 1", { intervalMs: 5, timeoutMs: 1 }),
    ).rejects.toThrow("Erasure 01ARZ3NDEKTSV4RRFFQ69G5FB1 is still running.");
  });
});
