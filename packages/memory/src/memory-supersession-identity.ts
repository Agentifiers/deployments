import type { CanonicalMemoryRecord } from "./memory-record.ts";

export function supersessionIdentityMatches(
  predecessor: CanonicalMemoryRecord,
  successor: CanonicalMemoryRecord,
) {
  if (
    predecessor.data.scope !== successor.data.scope ||
    predecessor.data.workspaceId !== successor.data.workspaceId
  ) {
    return false;
  }
  if (successor.data.scope === "thread") {
    return predecessor.data.threadId === successor.data.threadId;
  }
  if (successor.data.scope === "agent") {
    return predecessor.data.agentDefinitionId === successor.data.agentDefinitionId;
  }
  return true;
}
