import type { PlatformRecord } from "@deployments-ai/db";

export type CanonicalMemoryRecord = Extract<PlatformRecord, { readonly itemType: "memory" }>;
export type MemorySensitivity = CanonicalMemoryRecord["data"]["sensitivity"];

export function memoryScopeKey(memory: CanonicalMemoryRecord) {
  switch (memory.data.scope) {
    case "agent": {
      if (!memory.data.agentDefinitionId)
        throw new TypeError("Agent memory is missing agentDefinitionId.");
      return `agent:${memory.data.agentDefinitionId}`;
    }
    case "thread": {
      if (!memory.data.threadId) throw new TypeError("Thread memory is missing threadId.");
      return `thread:${memory.data.threadId}`;
    }
    case "workspace": {
      if (!memory.data.workspaceId) throw new TypeError("Workspace memory is missing workspaceId.");
      return `workspace:${memory.data.workspaceId}`;
    }
    case "organization":
      return `organization:${memory.data.organizationId}`;
    default:
      throw new TypeError(`Unsupported memory scope: ${String(memory.data.scope)}`);
  }
}
