import type { AgentEmailApplicationService } from "./api-handler.ts";
import { executeAgentEmailAdministrationRoute } from "./application-administration-routes.ts";
import { createAgentEmailDraftOperations } from "./application-draft-operations.ts";
import { executeAgentEmailInboxRoute } from "./application-inbox-routes.ts";
import { createAgentEmailResourceOperations } from "./application-resource-operations.ts";
import { AGENT_EMAIL_ROUTE_UNHANDLED } from "./application-route-operations.ts";
import { createAgentEmailSendOperations } from "./application-send-operations.ts";
import { createAgentEmailApplicationContext } from "./application-service-context.ts";
import type { DynamoAgentEmailApplicationServiceDependencies } from "./application-service-support.ts";
import { createAgentEmailUsageOperations } from "./application-usage-operations.ts";

export * from "./application-service-support.ts";

export function createDynamoAgentEmailApplicationService(
  dependencies: DynamoAgentEmailApplicationServiceDependencies,
): AgentEmailApplicationService {
  const context = createAgentEmailApplicationContext(dependencies);
  const draftOperations = createAgentEmailDraftOperations(context);
  const service = {
    ...context,
    ...draftOperations,
    ...createAgentEmailResourceOperations(context),
    ...createAgentEmailSendOperations(context, draftOperations),
    ...createAgentEmailUsageOperations(context),
  };
  return {
    async execute(operation, invocation) {
      const inboxResult = await executeAgentEmailInboxRoute(operation, invocation, service);
      if (inboxResult !== AGENT_EMAIL_ROUTE_UNHANDLED) return inboxResult;
      const administrationResult = await executeAgentEmailAdministrationRoute(
        operation,
        invocation,
        service,
      );
      if (administrationResult !== AGENT_EMAIL_ROUTE_UNHANDLED) return administrationResult;
      throw new Error(`Unsupported agent email operation: ${operation}`);
    },
  };
}
