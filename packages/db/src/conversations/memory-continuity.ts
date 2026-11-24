import type { DynamoDatabaseService } from "../client-types.ts";
import type { Ulid } from "../ids.ts";
import {
  InvalidConversationContinuityError,
  MAX_CONVERSATION_CONTINUATION_PREDECESSORS,
  validatedConversationPredecessorThreads,
} from "./continuation-ancestry.ts";

// Memory search accepts at most 50 keys. Reserving organization, workspace, and agent keys leaves
// room for the current thread plus this many validated predecessors.
export const MAX_MEMORY_CONTINUATION_PREDECESSORS = MAX_CONVERSATION_CONTINUATION_PREDECESSORS;

export class InvalidConversationMemoryContinuityError extends InvalidConversationContinuityError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidConversationMemoryContinuityError";
  }
}

export function makeConversationMemoryContinuityPersistence(database: DynamoDatabaseService) {
  return {
    async validatedPredecessorThreadIds(input: {
      readonly agentDefinitionId: Ulid;
      readonly currentAgentDeploymentId: Ulid;
      readonly environmentId: Ulid;
      readonly organizationId: Ulid;
      readonly projectId: Ulid;
      readonly threadId: Ulid;
      readonly workspaceId?: Ulid;
    }): Promise<readonly Ulid[]> {
      try {
        return (await validatedConversationPredecessorThreads(database, input)).map(
          (thread) => thread.data.id,
        );
      } catch (cause) {
        if (cause instanceof InvalidConversationContinuityError) {
          throw new InvalidConversationMemoryContinuityError(cause.message);
        }
        throw cause;
      }
    },
  };
}
