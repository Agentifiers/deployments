import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { Ulid } from "@deployments-ai/db";
import {
  GovernanceError,
  decodeMemorySearchErasureResult,
  type MemorySearchErasureResult,
} from "@deployments-ai/governance";
import { Schema } from "effect";
import type { LambdaInvoker } from "./observability-erasure.ts";

const MEMORY_SEARCH_ERASURE_FUNCTION_ENV = "DEPLOYMENTS_AI_MEMORY_ERASURE_FUNCTION_NAME" as const;

const MEMORY_SEARCH_WAITS = {
  cleanup_receipts_compacting: {
    code: "memory_search_purge_pending",
    message: "Historical memory cleanup receipt compaction remains pending.",
  },
  live_purge_running: {
    code: "memory_search_purge_pending",
    message: "Memory provider live purge remains pending.",
  },
  provider_mutations_draining: {
    code: "memory_search_drain_pending",
    message: "Memory provider mutations are draining; erasure remains pending.",
  },
  target_records_compacting: {
    code: "memory_search_purge_pending",
    message: "Memory search target compaction remains pending.",
  },
} as const satisfies Record<
  Extract<MemorySearchErasureResult, { readonly status: "pending" }>["reason"],
  { readonly code: string; readonly message: string }
>;

function memoryErasureFunction(environment: NodeJS.ProcessEnv, client: LambdaInvoker) {
  const functionName = environment[MEMORY_SEARCH_ERASURE_FUNCTION_ENV]?.trim();
  if (!functionName) {
    throw new Error(`${MEMORY_SEARCH_ERASURE_FUNCTION_ENV} is required for governance erasure.`);
  }
  return async (request: Readonly<Record<string, unknown>>): Promise<unknown> => {
    const response = await client.send(
      new InvokeCommand({
        FunctionName: functionName,
        InvocationType: "RequestResponse",
        Payload: Buffer.from(JSON.stringify(request)),
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
      throw new Error(`Memory search erasure failed: ${message}`);
    }
    return payload;
  };
}

export function makeMemorySearchErasureInvoker(
  environment: NodeJS.ProcessEnv,
  client: LambdaInvoker = new LambdaClient({}),
) {
  const invoke = memoryErasureFunction(environment, client);
  return async (organizationId: string, operationId: string) => {
    const payload = await invoke({ operationId, organizationId });
    let result: MemorySearchErasureResult;
    try {
      result = decodeMemorySearchErasureResult(payload, operationId);
    } catch (cause) {
      throw new Error("Memory search erasure failed: provider returned an invalid receipt.", {
        cause,
      });
    }
    if (result.status === "complete") return result.receipt;
    const wait = MEMORY_SEARCH_WAITS[result.reason];
    throw new GovernanceError(wait.code, wait.message);
  };
}

const ThreadMemoryPurgeReceipt = Schema.Struct({
  operationId: Ulid,
  targets: Schema.Array(
    Schema.Struct({
      contentPurged: Schema.Literal(true),
      memoryCount: Schema.Number,
      providerId: Schema.String,
      targetId: Schema.String,
    }),
  ),
  threadId: Ulid,
});

export function decodeThreadMemoryPurgeReceipt(
  payload: unknown,
  expected: {
    readonly memoryCount: number;
    readonly operationId: string;
    readonly threadId: string;
  },
) {
  const receipt = Schema.decodeUnknownSync(ThreadMemoryPurgeReceipt)(payload);
  if (receipt.operationId !== expected.operationId || receipt.threadId !== expected.threadId) {
    throw new Error("Thread memory purge receipt does not match the erased thread.");
  }
  if (
    receipt.targets.length === 0 ||
    receipt.targets.some((target) => target.memoryCount !== expected.memoryCount)
  ) {
    throw new Error("Thread memory purge receipt does not cover every memory on every target.");
  }
  return receipt;
}

export function makeThreadMemoryPurgeInvoker(environment: NodeJS.ProcessEnv) {
  const invoke = memoryErasureFunction(environment, new LambdaClient({}));
  return async (input: {
    readonly memories: readonly { readonly pk: string; readonly sk: string }[];
    readonly operationId: string;
    readonly organizationId: string;
    readonly threadId: string;
  }) => {
    const payload = await invoke(input);
    try {
      decodeThreadMemoryPurgeReceipt(payload, { ...input, memoryCount: input.memories.length });
    } catch (cause) {
      throw new Error("Thread memory purge failed: provider returned an invalid receipt.", {
        cause,
      });
    }
  };
}
