import { Effect } from "effect";
import { E2eConfigurationError } from "./errors.ts";
import {
  channelApiE2eConfig,
  optional,
  scopedE2eConfig,
  type ChannelApiE2eConfig,
  type ScopedE2eConfig,
} from "./live-config.ts";

const TELEGRAM_BOT_TOKEN_PATTERN = /^(\d+):[A-Za-z0-9_-]{30,}$/u;
const TELEGRAM_PRIVATE_CHAT_ID_PATTERN = /^[1-9]\d{0,19}$/u;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/u;
// OAuth authorization attempts expire after ten minutes; keep a margin for callback persistence.
const PROVIDER_OAUTH_MAX_AUTHORIZATION_WAIT_MS = 540_000;
const PROVIDER_OAUTH_DEFAULT_AUTHORIZATION_WAIT_MS = 300_000;

interface TelegramIngressE2eConfig extends ChannelApiE2eConfig {
  readonly telegramBotId: string;
  readonly telegramBotToken: string;
  readonly telegramChatId: string;
}

interface ProviderOAuthE2eConfig extends ScopedE2eConfig {
  readonly githubOAuthApplicationId: string;
  readonly providerOAuthAuthorizationTimeoutMs: number;
}

export function telegramIngressE2eEnabled(): boolean {
  return process.env.DEPLOYMENTS_E2E_TELEGRAM_LIVE?.trim().toLowerCase() === "true";
}

export function providerOAuthE2eEnabled(): boolean {
  return process.env.DEPLOYMENTS_E2E_PROVIDER_OAUTH_LIVE?.trim().toLowerCase() === "true";
}

export const telegramIngressE2eConfig = channelApiE2eConfig.pipe(
  Effect.flatMap((config) => {
    const botToken = optional("DEPLOYMENTS_E2E_TELEGRAM_BOT_TOKEN");
    const chatId = optional("DEPLOYMENTS_E2E_TELEGRAM_CHAT_ID");
    const missing = [
      ...(botToken ? [] : ["DEPLOYMENTS_E2E_TELEGRAM_BOT_TOKEN"]),
      ...(chatId ? [] : ["DEPLOYMENTS_E2E_TELEGRAM_CHAT_ID"]),
    ];
    if (missing.length > 0) {
      return Effect.fail(
        new E2eConfigurationError({
          message: `Telegram ingress E2E is enabled but missing configuration: ${missing.join(", ")}.`,
        }),
      );
    }
    const botId = TELEGRAM_BOT_TOKEN_PATTERN.exec(botToken!)?.[1];
    if (!botId) {
      return Effect.fail(
        new E2eConfigurationError({
          message:
            "DEPLOYMENTS_E2E_TELEGRAM_BOT_TOKEN must be a BotFather token in <bot-id>:<secret> form.",
        }),
      );
    }
    if (!TELEGRAM_PRIVATE_CHAT_ID_PATTERN.test(chatId!)) {
      return Effect.fail(
        new E2eConfigurationError({
          message:
            "DEPLOYMENTS_E2E_TELEGRAM_CHAT_ID must be the positive private-chat ID of the sandbox user who started the bot.",
        }),
      );
    }
    return Effect.succeed({
      ...config,
      telegramBotId: botId,
      telegramBotToken: botToken!,
      telegramChatId: chatId!,
    } satisfies TelegramIngressE2eConfig);
  }),
);

export const providerOAuthE2eConfig = scopedE2eConfig.pipe(
  Effect.flatMap((config) => {
    const applicationId = optional("DEPLOYMENTS_E2E_GITHUB_OAUTH_APPLICATION_ID");
    const rawTimeout = optional("DEPLOYMENTS_E2E_PROVIDER_OAUTH_AUTHORIZATION_TIMEOUT_MS");
    if (!applicationId) {
      return Effect.fail(
        new E2eConfigurationError({
          message:
            "Provider OAuth E2E is enabled but missing configuration: DEPLOYMENTS_E2E_GITHUB_OAUTH_APPLICATION_ID.",
        }),
      );
    }
    if (!ULID_PATTERN.test(applicationId)) {
      return Effect.fail(
        new E2eConfigurationError({
          message:
            "DEPLOYMENTS_E2E_GITHUB_OAUTH_APPLICATION_ID must be the ULID of the seeded GitHub provider application.",
        }),
      );
    }
    const timeoutMs =
      rawTimeout === undefined ? PROVIDER_OAUTH_DEFAULT_AUTHORIZATION_WAIT_MS : Number(rawTimeout);
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 60_000 ||
      timeoutMs > PROVIDER_OAUTH_MAX_AUTHORIZATION_WAIT_MS
    ) {
      return Effect.fail(
        new E2eConfigurationError({
          message: `DEPLOYMENTS_E2E_PROVIDER_OAUTH_AUTHORIZATION_TIMEOUT_MS must be an integer from 60000 to ${String(PROVIDER_OAUTH_MAX_AUTHORIZATION_WAIT_MS)}.`,
        }),
      );
    }
    return Effect.succeed({
      ...config,
      githubOAuthApplicationId: applicationId,
      providerOAuthAuthorizationTimeoutMs: timeoutMs,
    } satisfies ProviderOAuthE2eConfig);
  }),
);
