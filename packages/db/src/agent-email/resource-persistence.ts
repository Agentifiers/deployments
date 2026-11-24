import type { AgentEmailRepositoryContext } from "./persistence-context.ts";
import { makeAgentEmailResourceReadRepository } from "./resource-read-persistence.ts";
import { makeAgentEmailResourceWriteRepository } from "./resource-write-persistence.ts";

export function makeAgentEmailResourceRepository(context: AgentEmailRepositoryContext) {
  return {
    ...makeAgentEmailResourceReadRepository(context),
    ...makeAgentEmailResourceWriteRepository(context),
  };
}
