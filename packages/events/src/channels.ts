export const CHANNEL_EVENT_TYPES = [
  "channel.binding.created",
  "channel.binding.updated",
  "channel.binding.deleted",
  "channel.message.received",
  "channel.delivery.queued",
  "channel.delivery.retrying",
  "channel.delivery.sending",
  "channel.delivery.sent",
  "channel.delivery.failed",
] as const;

export type ChannelEventType = (typeof CHANNEL_EVENT_TYPES)[number];
