import { makeAgentEmailDraftAndCleanupRepository } from "./draft-and-cleanup-persistence.ts";
import { makeAgentEmailMessageReadRepository } from "./message-read-persistence.ts";
import { makeAgentEmailMessageUpdateRepository } from "./message-update-persistence.ts";
import { makeAgentEmailMessageWriteRepository } from "./message-write-persistence.ts";
import type { AgentEmailRepositoryContext } from "./persistence-context.ts";

export function makeAgentEmailMessageRepository(context: AgentEmailRepositoryContext) {
  return {
    ...makeAgentEmailDraftAndCleanupRepository(context),
    ...makeAgentEmailMessageReadRepository(context),
    ...makeAgentEmailMessageWriteRepository(context),
    ...makeAgentEmailMessageUpdateRepository(context),
  };
}
