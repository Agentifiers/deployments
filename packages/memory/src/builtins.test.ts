import { describe, expect, it } from "bun:test";
import type { MemoryPlatform } from "./platform.ts";
import { executeMemoryBuiltinTool } from "./builtins.ts";
import { ids } from "./test-fixtures.ts";
const scope = {
  environmentId: ids.environment,
  organizationId: ids.organization,
  projectId: ids.project,
};

const access = {
  agentDefinitionId: ids.agent,
  readMemorySpaces: [{ id: ids.space, workspaceId: ids.workspace }],
  readMemorySpaceIds: [ids.space],
  run: {
    data: {
      captureMode: "metadata-only",
      id: ids.run,
      spanId: "0123456789abcdef",
      threadId: ids.thread,
      traceId: "0123456789abcdef0123456789abcdef",
      workspaceId: ids.workspace,
    },
  },
  searchKeys: [
    `organization:${ids.organization}`,
    `workspace:${ids.workspace}`,
    `agent:${ids.agent}`,
    `thread:${ids.thread}`,
  ],
  writeMemorySpaces: [{ id: ids.space, workspaceId: ids.workspace }],
  writeMemorySpaceIds: [ids.space],
};

describe("memory built-in tools", () => {
  it("searches only run-granted spaces and run-visible scope keys", async () => {
    let received: unknown;
    const platform = {
      memoryAccessForRun: async () => access,
      search: async (_scope: unknown, input: unknown) => {
        received = input;
        return { attempt: {}, results: [], retrievals: [] };
      },
    } as unknown as MemoryPlatform;

    const result = await executeMemoryBuiltinTool(platform, scope, {
      input: { limit: 50, query: "deployment window" },
      runId: ids.run,
      toolCallId: ids.toolCall,
      toolName: "agent.memory.search",
    });

    expect(received).toMatchObject({
      allowedScopeKeys: access.searchKeys,
      memorySpaceIds: access.readMemorySpaceIds,
      purpose: "tool-search",
      query: "deployment window",
      searchKeys: access.searchKeys,
      topK: 20,
    });
    expect(result).toEqual({
      outputSummary: "No relevant approved memory was found.",
      status: "completed",
    });
  });

  it("saves with run-derived scope identifiers and tool-call idempotency", async () => {
    let received: unknown;
    const platform = {
      importMemories: async (_scope: unknown, input: unknown) => {
        received = input;
        return {
          imported: [
            {
              data: {
                id: ids.memory,
                reviewStatus: "approved",
                scope: "thread",
              },
            },
          ],
          rejected: [],
          replayed: [],
        };
      },
      memoryAccessForRun: async () => access,
    } as unknown as MemoryPlatform;

    const result = await executeMemoryBuiltinTool(platform, scope, {
      input: { content: "Use the Tuesday change window.", scope: "thread" },
      runId: ids.run,
      toolCallId: ids.toolCall,
      toolName: "agent.memory.save",
    });

    expect(received).toMatchObject({
      items: [
        {
          idempotencyKey: `memory-tool:${ids.toolCall}`,
          observability: {
            captureMode: "metadata-only",
            runSpanId: "0123456789abcdef",
            sessionId: ids.thread,
            traceId: "0123456789abcdef0123456789abcdef",
            workspaceId: ids.workspace,
          },
          scope: "thread",
          source: "tool",
          sourceRunId: ids.run,
          threadId: ids.thread,
        },
      ],
      memorySpaceId: ids.space,
    });
    expect(result.outputSummary).toContain("approved for recall");
  });

  it("rejects writes to spaces without a read-write grant", async () => {
    const platform = {
      memoryAccessForRun: async () => ({
        ...access,
        writeMemorySpaceIds: [],
        writeMemorySpaces: [],
      }),
    } as unknown as MemoryPlatform;

    expect(
      executeMemoryBuiltinTool(platform, scope, {
        input: { content: "Durable fact" },
        runId: ids.run,
        toolCallId: ids.toolCall,
        toolName: "agent.memory.save",
      }),
    ).rejects.toThrow("write access");
  });

  it("selects a writable space compatible with the requested memory scope", async () => {
    let received: unknown;
    const organizationSpaceId = ids.memory2;
    const platform = {
      importMemories: async (_scope: unknown, input: unknown) => {
        received = input;
        return {
          imported: [{ data: { id: ids.memory, reviewStatus: "pending", scope: "organization" } }],
          rejected: [],
          replayed: [],
        };
      },
      memoryAccessForRun: async () => ({
        ...access,
        writeMemorySpaceIds: [ids.space, organizationSpaceId],
        writeMemorySpaces: [
          { id: ids.space, workspaceId: ids.workspace },
          { id: organizationSpaceId },
        ],
      }),
    } as unknown as MemoryPlatform;

    await executeMemoryBuiltinTool(platform, scope, {
      input: { content: "Organization standard", scope: "organization" },
      runId: ids.run,
      toolCallId: ids.toolCall,
      toolName: "agent.memory.save",
    });

    expect(received).toMatchObject({ memorySpaceId: organizationSpaceId });
  });

  it("rejects an explicitly requested space with incompatible ownership", async () => {
    const platform = {
      memoryAccessForRun: async () => access,
    } as unknown as MemoryPlatform;

    expect(
      executeMemoryBuiltinTool(platform, scope, {
        input: {
          content: "Organization standard",
          memorySpaceId: ids.space,
          scope: "organization",
        },
        runId: ids.run,
        toolCallId: ids.toolCall,
        toolName: "agent.memory.save",
      }),
    ).rejects.toThrow("compatible");
  });
});
