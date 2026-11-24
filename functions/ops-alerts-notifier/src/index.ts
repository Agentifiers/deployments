import { loadAwsSecretString } from "@deployments-ai/secret-store";
import { Schema } from "effect";
import { parseOpsNotifications } from "./ops-notification.ts";
import { renderSlackMessage, type SlackMessage } from "./slack-message.ts";

export interface OpsAlertsDependencies {
  readonly environment: string;
  readonly channelId: string | undefined;
  readonly loadBotToken: () => Promise<string>;
  readonly slackApiBaseUrl: string;
}

type SlackDelivery =
  | {
      readonly kind: "unconfigured";
      readonly reason: "slack-channel-unset" | "slack-bot-token-pending";
    }
  | { readonly channelId: string; readonly kind: "ready"; readonly token: string };

const decodeSlackResponse = Schema.decodeUnknownSync(
  Schema.Union([
    Schema.Struct({ ok: Schema.Literal(true) }),
    Schema.Struct({ error: Schema.String, ok: Schema.Literal(false) }),
  ]),
);

async function slackDelivery(dependencies: OpsAlertsDependencies): Promise<SlackDelivery> {
  if (dependencies.channelId === undefined) {
    return { kind: "unconfigured", reason: "slack-channel-unset" };
  }
  const token = (await dependencies.loadBotToken()).trim();
  return token === "pending"
    ? { kind: "unconfigured", reason: "slack-bot-token-pending" }
    : { channelId: dependencies.channelId, kind: "ready", token };
}

async function postSlackMessage(slackApiBaseUrl: string, token: string, message: SlackMessage) {
  const response = await fetch(`${slackApiBaseUrl}/chat.postMessage`, {
    body: JSON.stringify(message),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
    },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`Slack chat.postMessage returned HTTP ${response.status}.`);
  }
  const result = decodeSlackResponse(await response.json());
  if (!result.ok) {
    throw new Error(`Slack chat.postMessage failed with ${result.error}.`);
  }
}

export function createOpsAlertsHandler(dependencies: OpsAlertsDependencies) {
  return async (event: unknown): Promise<void> => {
    const notifications = parseOpsNotifications(event);
    const { environment } = dependencies;
    const delivery = await slackDelivery(dependencies);
    if (delivery.kind === "unconfigured") {
      console.warn(
        JSON.stringify({
          environment,
          level: "warn",
          message: "Ops alert was not sent to Slack because the notifier is unconfigured.",
          reason: delivery.reason,
        }),
      );
      return;
    }
    for (const notification of notifications) {
      await postSlackMessage(
        dependencies.slackApiBaseUrl,
        delivery.token,
        renderSlackMessage({ channelId: delivery.channelId, environment, notification }),
      );
    }
  };
}

function requiredEnvironmentVariable(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set.`);
  return value;
}

export const handler = (event: unknown) =>
  createOpsAlertsHandler({
    channelId: process.env.OPS_ALERTS_SLACK_CHANNEL_ID?.trim() || undefined,
    environment: requiredEnvironmentVariable("OPS_ALERTS_ENVIRONMENT"),
    loadBotToken: () =>
      loadAwsSecretString(requiredEnvironmentVariable("OPS_ALERTS_SLACK_BOT_TOKEN_PARAMETER_ARN")),
    slackApiBaseUrl: "https://slack.com/api",
  })(event);
