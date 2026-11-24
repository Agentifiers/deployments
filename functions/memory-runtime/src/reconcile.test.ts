import { describe, expect, it } from "bun:test";
import type { MemoryPlatform } from "@deployments-ai/memory";
import { handleMemoryReconcile } from "./reconcile.ts";
const scope = {
  environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FA2",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FA5",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FA6",
};

function recordingPlatform() {
  const calls: unknown[][] = [];
  const platform = {
    reconcile: async (...received: unknown[]) => {
      calls.push(["reconcile", ...received]);
      return { inspected: 1, queued: 1 };
    },
    verifyIndexStates: async (...received: unknown[]) => {
      calls.push(["verifyIndexStates", ...received]);
      return { queued: 3 };
    },
  } as unknown as MemoryPlatform;
  return { calls, platform };
}

describe("memory reconciliation", () => {
  it("reconciles a scheduled tenant and verifies at most 50 of its oldest index states", async () => {
    const { calls, platform } = recordingPlatform();

    const result = await handleMemoryReconcile(scope, { platform });

    expect(result).toEqual({ inspected: 1, queued: 1, verified: 3 });
    expect(calls).toEqual([
      ["reconcile", scope, {}],
      ["verifyIndexStates", scope, { limit: 50 }],
    ]);
  });

  it("rejects malformed scheduled tenant identifiers before reconciliation", async () => {
    const { calls, platform } = recordingPlatform();

    expect(
      handleMemoryReconcile({ ...scope, environmentId: "not-a-ulid" }, { platform }),
    ).rejects.toThrow("environmentId must be a valid ULID");
    expect(calls).toEqual([]);
  });

  it("forwards a direct-invocation continuation cursor", async () => {
    const { calls, platform } = recordingPlatform();

    await handleMemoryReconcile({ ...scope, cursor: "opaque-cursor" }, { platform });

    expect(calls).toEqual([
      ["reconcile", scope, { cursor: "opaque-cursor" }],
      ["verifyIndexStates", scope, { limit: 50 }],
    ]);
  });

  it("reconciles queued change and continuation events without provider verification", async () => {
    const { calls, platform } = recordingPlatform();
    const record = (payload: Record<string, unknown>, messageId: string) => ({
      body: JSON.stringify({ detail: { ...scope, payload } }),
      messageId,
    });

    const result = await handleMemoryReconcile(
      {
        Records: [
          record({ cursor: "next-page", workspaceId: "01ARZ3NDEKTSV4RRFFQ69G5FA8" }, "message-1"),
          record({}, "message-2"),
        ],
      },
      { platform },
    );

    expect(result).toEqual({ batchItemFailures: [] });
    expect(calls).toEqual([
      [
        "reconcile",
        { ...scope, workspaceId: "01ARZ3NDEKTSV4RRFFQ69G5FA8" },
        { cursor: "next-page" },
      ],
      ["reconcile", scope, {}],
    ]);
  });
});
