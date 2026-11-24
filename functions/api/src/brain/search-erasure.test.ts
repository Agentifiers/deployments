import { describe, expect, test } from "bun:test";
import { GovernanceError } from "@deployments-ai/governance";
import { decodeBrainSearchErasureResult, makeBrainSearchErasureInvoker } from "./search-erasure.ts";

const operationId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const organizationId = "01ARZ3NDEKTSV4RRFFQ69G5FB1";
const targetId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const componentIds = [
  "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  "01ARZ3NDEKTSV4RRFFQ69G5FAY",
  "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
  "01ARZ3NDEKTSV4RRFFQ69G5FB0",
] as const;

function receipt(stores: readonly string[]) {
  return {
    operationId,
    targets: [
      {
        componentReceipts: stores.map((store, index) => ({
          componentId: componentIds[index]!,
          generationId: targetId,
          providerReceipt: {
            absenceVerified: true as const,
            receiptDigest: `proof-${index}`,
            store,
          },
        })),
        providerId: "aws-native" as const,
        targetDigest: "target-proof",
      },
    ],
  };
}

function complete(stores: readonly string[]) {
  return { receipt: receipt(stores), status: "complete" };
}

function brainSearchErasure(response: {
  readonly FunctionError?: string;
  readonly payload: unknown;
}) {
  return makeBrainSearchErasureInvoker(
    { DEPLOYMENTS_AI_BRAIN_ERASURE_FUNCTION_NAME: "brain-search-erasure" },
    {
      send: async () => ({
        ...(response.FunctionError ? { FunctionError: response.FunctionError } : {}),
        Payload: Buffer.from(JSON.stringify(response.payload)),
      }),
    },
  )(organizationId, operationId);
}

describe("Brain search erasure result validation", () => {
  test("requires OpenSearch absence evidence for every AWS-native retrieval component", () => {
    const covered = complete(["opensearch", "opensearch", "opensearch", "opensearch"]);

    expect<unknown>(decodeBrainSearchErasureResult(covered, operationId)).toEqual(covered);
    expect(() =>
      decodeBrainSearchErasureResult(
        complete(["opensearch", "opensearch", "opensearch", "object-store"]),
        operationId,
      ),
    ).toThrow();
    expect(() =>
      decodeBrainSearchErasureResult(
        complete(["opensearch", "opensearch", "opensearch"]),
        operationId,
      ),
    ).toThrow("all four retrieval components");
  });
});

describe("Brain search erasure invoker", () => {
  test("acknowledges a pending draining result as the Brain search drain wait", async () => {
    const failure = await brainSearchErasure({
      payload: { reason: "provider_mutations_draining", status: "pending" },
    }).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(GovernanceError);
    expect(failure).toMatchObject({ code: "brain_search_drain_pending" });
  });

  test("returns the verified receipt of a complete result", async () => {
    const covered = receipt(["opensearch", "opensearch", "opensearch", "opensearch"]);

    expect<unknown>(
      await brainSearchErasure({ payload: { receipt: covered, status: "complete" } }),
    ).toEqual(covered);
  });

  test.each([
    ["a pending result with an unknown reason", { reason: "waiting", status: "pending" }],
    [
      "a pending result with an excess property",
      { reason: "provider_mutations_draining", retryAfterSeconds: 60, status: "pending" },
    ],
    [
      "a complete result with an excess property",
      {
        ...complete(["opensearch", "opensearch", "opensearch", "opensearch"]),
        partial: true,
      },
    ],
    ["a result with an unknown status", { status: "queued" }],
  ])("rejects %s as an invalid receipt", async (_label, payload) => {
    const failure = await brainSearchErasure({ payload }).catch((cause: unknown) => cause);

    expect(failure).toMatchObject({
      message: "Brain search erasure failed: provider returned an invalid receipt.",
    });
  });

  test("treats every function error as a failure, even one that names a wait", async () => {
    const failure = await brainSearchErasure({
      FunctionError: "Unhandled",
      payload: { errorMessage: "Brain provider mutations are draining before erasure." },
    }).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(GovernanceError);
    expect(failure).not.toHaveProperty("code");
    expect(failure).toMatchObject({
      message: "Brain search erasure failed: Brain provider mutations are draining before erasure.",
    });
  });
});
