import { describe, expect, it } from "bun:test";
import { GovernanceError } from "@deployments-ai/governance";
import {
  decodeThreadMemoryPurgeReceipt,
  makeMemorySearchErasureInvoker,
} from "./memory-search-erasure.ts";

const ids = {
  memory2: "01ARZ3NDEKTSV4RRFFQ69G5FA3",
  organization: "01ARZ3NDEKTSV4RRFFQ69G5FA6",
  run: "01ARZ3NDEKTSV4RRFFQ69G5FA4",
  toolCall: "01ARZ3NDEKTSV4RRFFQ69G5FA5",
} as const;

const memorySearchReceipt = {
  operationId: ids.toolCall,
  targets: [
    {
      backupErasureEligibleAt: "2026-08-11T13:10:00.000Z",
      componentReceipts: [
        {
          componentId: ids.memory2,
          generationId: ids.run,
          providerReceipt: { absenceVerified: true, receiptDigest: "component-proof" },
        },
      ],
      providerId: "aws-native",
      targetDigest: "target-proof",
    },
  ],
};

function memorySearchErasure(response: {
  readonly FunctionError?: string;
  readonly payload: unknown;
}) {
  return makeMemorySearchErasureInvoker(
    { DEPLOYMENTS_AI_MEMORY_ERASURE_FUNCTION_NAME: "memory-erasure" },
    {
      send: async () => ({
        ...(response.FunctionError ? { FunctionError: response.FunctionError } : {}),
        Payload: Buffer.from(JSON.stringify(response.payload)),
      }),
    },
  )(ids.organization, ids.toolCall);
}

describe("memory search erasure invoker", () => {
  it.each([
    ["provider_mutations_draining", "memory_search_drain_pending"],
    ["live_purge_running", "memory_search_purge_pending"],
    ["cleanup_receipts_compacting", "memory_search_purge_pending"],
    ["target_records_compacting", "memory_search_purge_pending"],
  ])("acknowledges a pending %s result as the %s wait", async (reason, code) => {
    const failure = await memorySearchErasure({ payload: { reason, status: "pending" } }).catch(
      (cause: unknown) => cause,
    );

    expect(failure).toBeInstanceOf(GovernanceError);
    expect(failure).toMatchObject({ code });
  });

  it("returns the verified receipt of a complete result", async () => {
    expect<unknown>(
      await memorySearchErasure({ payload: { receipt: memorySearchReceipt, status: "complete" } }),
    ).toEqual(memorySearchReceipt);
  });

  it("rejects a pending result with an unknown reason", async () => {
    const failure = await memorySearchErasure({
      payload: { reason: "waiting", status: "pending" },
    }).catch((cause: unknown) => cause);

    expect(failure).toMatchObject({
      message: "Memory search erasure failed: provider returned an invalid receipt.",
    });
  });

  it("treats every function error as a failure, even one that names a wait", async () => {
    const failure = await memorySearchErasure({
      FunctionError: "Unhandled",
      payload: { errorMessage: "Memory provider mutations are draining; erasure remains pending." },
    }).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(GovernanceError);
    expect(failure).not.toHaveProperty("code");
    expect(failure).toMatchObject({
      message:
        "Memory search erasure failed: Memory provider mutations are draining; erasure remains pending.",
    });
  });
});

describe("thread memory purge receipt validation", () => {
  const receipt = {
    operationId: ids.toolCall,
    targets: [
      { contentPurged: true, memoryCount: 2, providerId: "aws-native", targetId: "primary" },
      { contentPurged: true, memoryCount: 2, providerId: "aws-native", targetId: "secondary" },
    ],
    threadId: ids.run,
  };
  const expected = { memoryCount: 2, operationId: ids.toolCall, threadId: ids.run };

  it("accepts the receipt of this thread and operation that purged every memory", () => {
    expect(
      decodeThreadMemoryPurgeReceipt(receipt, expected).targets.map((t) => t.targetId),
    ).toEqual(["primary", "secondary"]);
  });

  it("rejects a receipt for another thread or operation", () => {
    expect(() =>
      decodeThreadMemoryPurgeReceipt({ ...receipt, threadId: ids.memory2 }, expected),
    ).toThrow("does not match the erased thread");
    expect(() =>
      decodeThreadMemoryPurgeReceipt({ ...receipt, operationId: ids.memory2 }, expected),
    ).toThrow("does not match the erased thread");
  });

  it("rejects a receipt that skipped a memory or reached no target", () => {
    expect(() =>
      decodeThreadMemoryPurgeReceipt(
        { ...receipt, targets: [receipt.targets[0], { ...receipt.targets[1], memoryCount: 1 }] },
        expected,
      ),
    ).toThrow("does not cover every memory");
    expect(() => decodeThreadMemoryPurgeReceipt({ ...receipt, targets: [] }, expected)).toThrow(
      "does not cover every memory",
    );
  });
});
