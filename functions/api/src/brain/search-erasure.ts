import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { Ulid } from "@deployments-ai/db";
import { GovernanceError } from "@deployments-ai/governance";
import { Schema } from "effect";
import type { LambdaInvoker } from "../observability-erasure.ts";

const BRAIN_SEARCH_ERASURE_FUNCTION_ENV = "DEPLOYMENTS_AI_BRAIN_ERASURE_FUNCTION_NAME" as const;

const BrainSearchErasureReceipt = Schema.Struct({
  brainId: Schema.optional(Ulid),
  erasureGeneration: Schema.optional(Schema.Number.pipe(Schema.check(Schema.isInt()))),
  operationId: Ulid,
  targets: Schema.Array(
    Schema.Struct({
      componentReceipts: Schema.Array(
        Schema.Struct({
          componentId: Ulid,
          generationId: Ulid,
          providerReceipt: Schema.Struct({
            absenceVerified: Schema.Literal(true),
            receiptDigest: Schema.String,
            store: Schema.Literal("opensearch"),
          }),
        }),
      ),
      providerId: Schema.Literal("aws-native"),
      targetDigest: Schema.String,
    }),
  ),
});

const BrainSearchErasureResult = Schema.Union([
  Schema.Struct({
    reason: Schema.Literal("provider_mutations_draining"),
    status: Schema.Literal("pending"),
  }),
  Schema.Struct({
    receipt: BrainSearchErasureReceipt,
    status: Schema.Literal("complete"),
  }),
]);

const strict = { onExcessProperty: "error" } as const;

export type BrainSearchErasureResult = typeof BrainSearchErasureResult.Type;

function verifiedReceipt(
  receipt: typeof BrainSearchErasureReceipt.Type,
  expectedOperationId: string,
) {
  if (receipt.operationId !== expectedOperationId) {
    throw new Error("Brain search erasure receipt does not match the governance operation.");
  }
  for (const target of receipt.targets) {
    if (target.componentReceipts.length !== 4) {
      throw new Error("Brain search erasure receipt must cover all four retrieval components.");
    }
    const componentIds = new Set(target.componentReceipts.map((item) => item.componentId));
    if (
      componentIds.size !== target.componentReceipts.length ||
      target.componentReceipts.some((item) => !item.providerReceipt.receiptDigest)
    ) {
      throw new Error("Brain search erasure receipt has invalid component absence evidence.");
    }
  }
}

export function decodeBrainSearchErasureResult(payload: unknown, expectedOperationId: string) {
  const result = Schema.decodeUnknownSync(BrainSearchErasureResult, strict)(payload);
  if (result.status === "complete") verifiedReceipt(result.receipt, expectedOperationId);
  return result;
}

export function makeBrainSearchErasureInvoker(
  environment: NodeJS.ProcessEnv,
  client: LambdaInvoker = new LambdaClient({}),
) {
  const functionName = environment[BRAIN_SEARCH_ERASURE_FUNCTION_ENV]?.trim();
  if (!functionName) {
    throw new Error(`${BRAIN_SEARCH_ERASURE_FUNCTION_ENV} is required for governance erasure.`);
  }
  return async (organizationId: string, operationId: string) => {
    const response = await client.send(
      new InvokeCommand({
        FunctionName: functionName,
        InvocationType: "RequestResponse",
        Payload: Buffer.from(JSON.stringify({ operationId, organizationId })),
      }),
    );
    const payload = response.Payload
      ? JSON.parse(Buffer.from(response.Payload).toString("utf8"))
      : undefined;
    if (response.FunctionError) {
      const message =
        payload && typeof payload === "object" && "errorMessage" in payload
          ? String(payload.errorMessage)
          : response.FunctionError;
      throw new Error(`Brain search erasure failed: ${message}`);
    }
    let result: typeof BrainSearchErasureResult.Type;
    try {
      result = decodeBrainSearchErasureResult(payload, operationId);
    } catch (cause) {
      throw new Error("Brain search erasure failed: provider returned an invalid receipt.", {
        cause,
      });
    }
    if (result.status === "complete") return result.receipt;
    throw new GovernanceError(
      "brain_search_drain_pending",
      "Brain provider mutations are draining before erasure.",
    );
  };
}
