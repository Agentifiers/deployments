import type { ToolCallResponse } from "@deployments-ai/api-contract/runtime";
import type { RuntimeSdk } from "./runtime-sdk-client.ts";

/** A tool call the calling client must execute and answer with structured output. */
export type PendingClientToolCall = ToolCallResponse & {
  readonly executionType: "client";
  readonly input: Readonly<Record<string, unknown>>;
};

type ToolCallsSdk = Pick<RuntimeSdk, "toolCalls">;

function isPendingClientToolCall(toolCall: ToolCallResponse): toolCall is PendingClientToolCall {
  return toolCall.executionType === "client" && toolCall.status === "running";
}

/** Lists every client-executed tool call of a run that is still waiting for output. */
export async function listPendingClientToolCalls(
  sdk: ToolCallsSdk,
  runId: string,
): Promise<readonly PendingClientToolCall[]> {
  const pending: PendingClientToolCall[] = [];
  let cursor: string | undefined;
  do {
    const page = await sdk.toolCalls.list(runId, cursor ? { cursor } : {});
    pending.push(...page.data.toolCalls.filter(isPendingClientToolCall));
    cursor = page.data.nextCursor ?? undefined;
  } while (cursor);
  return pending;
}

export interface WaitForClientToolCallOptions {
  /** Polling interval; defaults to 1 second. */
  readonly intervalMs?: number;
  readonly signal?: AbortSignal;
  /** Maximum wait; defaults to 5 minutes. */
  readonly timeoutMs?: number;
}

/**
 * Polls a run until a client-executed tool call is pending, returning it, or `undefined` when the
 * run reaches a terminal status first.
 */
export async function waitForClientToolCall(
  sdk: ToolCallsSdk & Pick<RuntimeSdk, "runs">,
  run: { readonly runId: string; readonly threadId: string },
  options: WaitForClientToolCallOptions = {},
): Promise<PendingClientToolCall | undefined> {
  const { runId, threadId } = run;
  const deadline = Date.now() + (options.timeoutMs ?? 300_000);
  const intervalMs = options.intervalMs ?? 1_000;
  for (;;) {
    options.signal?.throwIfAborted();
    const [pending] = await listPendingClientToolCalls(sdk, runId);
    if (pending) return pending;
    const current = await sdk.runs.get(threadId, runId);
    if (["canceled", "completed", "failed"].includes(current.data.status)) return undefined;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for a client tool call on run ${runId}.`);
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, intervalMs);
    await promise;
  }
}

/** Submits the client's result for a pending client-executed tool call. */
export function submitClientToolOutput(
  sdk: ToolCallsSdk,
  toolCall: Pick<PendingClientToolCall, "id" | "runId">,
  input: {
    readonly threadId: string;
    readonly outcome?: "completed" | "failed";
    readonly output?: Readonly<Record<string, unknown>>;
    readonly outputSummary?: string;
  },
) {
  return sdk.toolCalls.resolve(toolCall.runId, toolCall.id, {
    outcome: input.outcome ?? "completed",
    ...(input.output ? { output: input.output } : {}),
    ...(input.outputSummary ? { outputSummary: input.outputSummary } : {}),
    threadId: input.threadId,
  });
}
