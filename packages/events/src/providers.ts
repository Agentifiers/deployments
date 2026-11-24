export const PROVIDER_EVENT_TYPES = [
  "provider.application.credentials.created",
  "provider.application.credentials.rotated",
  "provider.application.credentials.revoked",
  "provider.connection.authorized",
  "provider.connection.refreshed",
  "provider.connection.verified",
  "provider.connection.disconnected",
  "provider.webhook.received",
  "provider.webhook.ignored",
  "provider.tool.requested",
  "provider.tool.completed",
  "provider.tool.failed",
] as const;

export type ProviderEventType = (typeof PROVIDER_EVENT_TYPES)[number];
