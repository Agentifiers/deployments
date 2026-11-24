import type { AgentEmailDirection, AgentEmailMessageStatus } from "./models.ts";

export const AGENT_EMAIL_EVENT_SOURCE = "deployments-ai.agent-email" as const;

export const AGENT_EMAIL_EVENT_TYPES = [
  "agent-email.domain-created",
  "agent-email.domain-updated",
  "agent-email.inbox-created",
  "agent-email.inbox-updated",
  "agent-email.send-requested",
  "agent-email.raw-purged",
  "agent-email.received",
  "agent-email.accepted",
  "agent-email.delivered",
  "agent-email.bounced",
  "agent-email.complained",
  "agent-email.failed",
] as const;
export type AgentEmailEventType = (typeof AGENT_EMAIL_EVENT_TYPES)[number];

export interface AgentEmailEventContext {
  readonly agentId?: string;
  readonly appId?: string;
  readonly environmentId?: string;
  readonly projectId?: string;
  readonly workspaceId?: string;
}

export interface AgentEmailResourceEventPayload {
  readonly context?: AgentEmailEventContext;
  readonly occurredAt: string;
  readonly organizationId: string;
  readonly resourceId: string;
  readonly resourceType: "domain" | "inbox" | "message";
  readonly status: string;
  readonly version: 1;
}

export interface AgentEmailEventPayload {
  readonly address: string;
  readonly context?: AgentEmailEventContext;
  readonly direction: AgentEmailDirection;
  readonly failureCode?: string;
  readonly failureReason?: string;
  readonly fromAddress: string;
  readonly inboxId: string;
  readonly messageId: string;
  readonly occurredAt: string;
  readonly organizationId: string;
  readonly providerMessageId?: string;
  readonly status: AgentEmailMessageStatus;
  readonly subject: string;
  readonly toAddresses: readonly string[];
  readonly version: 2;
}

export interface AgentEmailDomainEvent {
  readonly aggregateId: string;
  readonly aggregateType: "agent_email";
  readonly eventId: string;
  readonly eventType: AgentEmailEventType;
  readonly payload: AgentEmailEventPayload | AgentEmailResourceEventPayload;
  readonly source: typeof AGENT_EMAIL_EVENT_SOURCE;
}

export function buildAgentEmailDomainEvent(
  args: Omit<AgentEmailDomainEvent, "aggregateType" | "source">,
) {
  return {
    ...args,
    aggregateType: "agent_email" as const,
    source: AGENT_EMAIL_EVENT_SOURCE,
  };
}
