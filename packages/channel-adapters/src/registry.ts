import type { ChannelProvider, ExternalAgentChannel } from "./shared/core.ts";

const CHANNEL_PROVIDER_COMPATIBILITY = {
  imessage: [],
  rcs: ["aws_end_user_messaging_rcs"],
  slack: ["slack_edge", "slack_cloudflare_edge"],
  sms: [],
  teams: ["teams_bot_framework"],
  telegram: ["telegram"],
} as const satisfies Record<ExternalAgentChannel, readonly ChannelProvider[]>;

export function channelProviders(channel: ExternalAgentChannel) {
  return CHANNEL_PROVIDER_COMPATIBILITY[channel];
}

export function channelProviderSupports(channel: ExternalAgentChannel, provider: ChannelProvider) {
  return (CHANNEL_PROVIDER_COMPATIBILITY[channel] as readonly ChannelProvider[]).includes(provider);
}

export function channelProviderRequiresExternalWorkspacePin(provider: ChannelProvider) {
  return (
    provider === "slack_cloudflare_edge" ||
    provider === "slack_edge" ||
    provider === "teams_bot_framework" ||
    provider === "telegram"
  );
}

export function defaultChannelProvider(channel: ExternalAgentChannel): ChannelProvider | undefined {
  return CHANNEL_PROVIDER_COMPATIBILITY[channel][0];
}
