import { createHash } from "node:crypto";

export function agentEmailSesTenantName(organizationId: string) {
  const digest = createHash("sha256").update(organizationId).digest("hex").slice(0, 40);
  return `agent-inboxes-${digest}`;
}
