import type { Ulid } from "@deployments-ai/db";
import {
  writableMemorySpaceForScope,
  type MemoryPlatform,
  type MemoryPlatformScope,
  type MemoryRunAccess,
} from "./platform.ts";
import type { MemoryScope } from "./governance.ts";
const DEFAULT_SEARCH_LIMIT = 8;
const MAX_SEARCH_LIMIT = 20;

export interface MemoryBuiltinToolRequest {
  readonly brainProvenance?: import("./platform-types.ts").BrainMemoryProvenance;
  readonly input?: unknown;
  readonly runId: Ulid;
  readonly toolCallId: Ulid;
  readonly toolName: "agent.memory.save" | "agent.memory.search";
}

export interface MemoryBuiltinToolResult {
  readonly outputSummary: string;
  readonly status: "completed";
}

function inputRecord(value: unknown) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Memory tool input must be an object.");
  }
  return value as Record<string, unknown>;
}

function requiredString(input: Record<string, unknown>, field: string) {
  const value = input[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`Memory tool input requires ${field}.`);
  }
  return value.trim();
}

function optionalString(input: Record<string, unknown>, field: string) {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`Memory tool input ${field} must be a non-empty string.`);
  }
  return value.trim();
}

function searchLimit(input: Record<string, unknown>) {
  const value = input.limit;
  if (value === undefined) return DEFAULT_SEARCH_LIMIT;
  const numeric = typeof value === "string" ? Number(value) : value;
  if (typeof numeric !== "number" || !Number.isSafeInteger(numeric) || numeric < 1) {
    throw new TypeError("Memory tool input limit must be a positive integer.");
  }
  return Math.min(numeric, MAX_SEARCH_LIMIT);
}

function memoryScope(input: Record<string, unknown>): MemoryScope {
  const value = optionalString(input, "scope") ?? "agent";
  if (
    value === "agent" ||
    value === "organization" ||
    value === "thread" ||
    value === "workspace"
  ) {
    return value;
  }
  throw new TypeError("Memory tool input scope is invalid.");
}

function writableSpace(
  input: Record<string, unknown>,
  access: MemoryRunAccess,
  selectedScope: MemoryScope,
) {
  const requested = optionalString(input, "memorySpaceId") as Ulid | undefined;
  if (
    access.writeMemorySpaceIds.length === 0 ||
    (requested && !access.writeMemorySpaceIds.includes(requested))
  ) {
    throw new TypeError("Agent does not have write access to the requested memory space.");
  }
  const selected = writableMemorySpaceForScope(access, selectedScope, requested);
  if (!selected) {
    throw new TypeError("No writable memory space is compatible with the requested memory scope.");
  }
  return selected.id;
}

function formattedSearch(results: Awaited<ReturnType<MemoryPlatform["search"]>>["results"]) {
  if (results.length === 0) return "No relevant approved memory was found.";
  return results
    .map((result, index) => {
      const content = result.memory.data.body ?? "Memory content unavailable.";
      return `${index + 1}. ${content} [memory ${result.memory.data.id}; score ${result.score.toFixed(4)}]`;
    })
    .join("\n");
}

export async function executeMemoryBuiltinTool(
  platform: MemoryPlatform,
  scope: MemoryPlatformScope,
  request: MemoryBuiltinToolRequest,
): Promise<MemoryBuiltinToolResult> {
  const input = inputRecord(request.input);
  const access = await platform.memoryAccessForRun(scope, request.runId, {
    includeThreadContinuity: request.toolName === "agent.memory.search",
  });
  const observability = {
    captureMode: access.run.data.captureMode,
    ...(access.run.data.parentSpanId ? { parentSpanId: access.run.data.parentSpanId } : {}),
    runSpanId: access.run.data.spanId,
    sessionId: access.run.data.threadId,
    traceId: access.run.data.traceId,
    ...(access.run.data.workspaceId ? { workspaceId: access.run.data.workspaceId } : {}),
  };
  if (request.toolName === "agent.memory.search") {
    if (access.readMemorySpaceIds.length === 0) {
      return { outputSummary: "No memory spaces are granted to this agent.", status: "completed" };
    }
    const result = await platform.search(
      {
        ...scope,
        ...(access.run.data.workspaceId ? { workspaceId: access.run.data.workspaceId } : {}),
      },
      {
        allowedScopeKeys: access.searchKeys,
        memorySpaceIds: access.readMemorySpaceIds,
        observability,
        purpose: "tool-search",
        query: requiredString(input, "query"),
        runId: request.runId,
        searchKeys: access.searchKeys,
        threadId: access.run.data.threadId,
        toolCallId: request.toolCallId,
        topK: searchLimit(input),
      },
    );
    return { outputSummary: formattedSearch(result.results), status: "completed" };
  }

  // Preview runs recall through their source deployment's grants but never write its memory.
  if (access.run.data.executionBindingId !== undefined) {
    throw new TypeError("Preview runs recall memory read-only and cannot save memories.");
  }
  const selectedScope = memoryScope(input);
  const imported = await platform.importMemories(
    {
      ...scope,
      ...(access.run.data.workspaceId ? { workspaceId: access.run.data.workspaceId } : {}),
    },
    {
      items: [
        {
          ...(selectedScope === "agent" ? { agentDefinitionId: access.agentDefinitionId } : {}),
          ...(request.brainProvenance ? { brainProvenance: request.brainProvenance } : {}),
          content: requiredString(input, "content"),
          idempotencyKey: `memory-tool:${request.toolCallId}`,
          observability,
          scope: selectedScope,
          source: "tool",
          sourceRunId: request.runId,
          ...(selectedScope === "thread" ? { threadId: access.run.data.threadId } : {}),
          ...(selectedScope === "workspace" && access.run.data.workspaceId
            ? { workspaceId: access.run.data.workspaceId }
            : {}),
        },
      ],
      memorySpaceId: writableSpace(input, access, selectedScope),
    },
  );
  const memory = imported.imported[0] ?? imported.replayed[0];
  if (!memory) {
    const reason = imported.rejected[0]?.reason ?? "Memory was rejected by governance.";
    throw new TypeError(reason);
  }
  const review =
    memory.data.reviewStatus === "approved"
      ? "It is approved for recall."
      : "It is pending review and will not be recalled until approved.";
  return {
    outputSummary: `Saved memory ${memory.data.id} for ${memory.data.scope} scope. ${review}`,
    status: "completed",
  };
}
