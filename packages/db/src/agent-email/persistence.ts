import type { DynamoDatabaseService } from "../client-types.ts";
import type { AgentEmailEndUserKeys } from "./mail-subjects.ts";
import { makeAgentEmailMessageRepository } from "./message-persistence.ts";
import { makeAgentEmailRepositoryContext } from "./persistence-context.ts";
import type { AgentEmailPlatformScope } from "./record-mapping.ts";
import { makeAgentEmailResourceRepository } from "./resource-persistence.ts";
import { makeAgentEmailRetentionRepository } from "./retention-persistence.ts";

export * from "./persistence-context.ts";
export {
  endUserInboxMailRecord,
  messageAddresses,
  type AgentEmailEndUserKeys,
} from "./mail-subjects.ts";
export { purgeExpiredAgentEmailRawObjects } from "./retention-persistence.ts";

export function makeAgentEmailDynamoRepository(
  database: DynamoDatabaseService,
  scope: AgentEmailPlatformScope,
  endUserKeys?: AgentEmailEndUserKeys,
) {
  const context = makeAgentEmailRepositoryContext(database, scope, endUserKeys);
  return {
    ...makeAgentEmailResourceRepository(context),
    ...makeAgentEmailMessageRepository(context),
    ...makeAgentEmailRetentionRepository(context),
  };
}
