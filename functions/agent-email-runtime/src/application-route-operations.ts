import type { createAgentEmailDraftOperations } from "./application-draft-operations.ts";
import type { createAgentEmailResourceOperations } from "./application-resource-operations.ts";
import type { createAgentEmailSendOperations } from "./application-send-operations.ts";
import type { AgentEmailApplicationContext } from "./application-service-context.ts";
import type { createAgentEmailUsageOperations } from "./application-usage-operations.ts";

export const AGENT_EMAIL_ROUTE_UNHANDLED = Symbol("agent-email-route-unhandled");

export type AgentEmailApplicationOperations = AgentEmailApplicationContext &
  ReturnType<typeof createAgentEmailDraftOperations> &
  ReturnType<typeof createAgentEmailResourceOperations> &
  ReturnType<typeof createAgentEmailSendOperations> &
  ReturnType<typeof createAgentEmailUsageOperations>;
