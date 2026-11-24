import { type AwsRcsDeliveryPayload } from "@deployments-ai/channel-adapters/aws-rcs";
import {
  TeamsConnectorError,
  readTeamsDeliveryPayload,
  sendTeamsDelivery,
  teamsBotCredentials,
  teamsConnectorClient,
  type TeamsBotCredentials,
  type TeamsConnectorClient,
  type TeamsDeliveryPayload,
} from "@deployments-ai/channel-adapters/teams";
import {
  TelegramApiError,
  sendTelegramDelivery,
  type TelegramDeliveryPayload,
} from "@deployments-ai/channel-adapters/telegram";

import { prepareAwsRcsDelivery, type PreparedAwsRcsDelivery } from "./aws-rcs-delivery.ts";
import type {
  ChannelDeliveryDependencies,
  Delivery,
  DeliveryCommand,
  DeliveryMessage,
  DeliveryProvider,
} from "./delivery-contract.ts";
import { stringField } from "./runtime.ts";

class SlackDeliveryError extends Error {
  readonly safeToRetry: boolean;

  constructor(message: string, safeToRetry: boolean) {
    super(message);
    this.name = "SlackDeliveryError";
    this.safeToRetry = safeToRetry;
  }
}

class PartialTelegramDeliveryError extends Error {
  constructor(sentParts: number, cause: unknown) {
    super(
      `Telegram delivery outcome is partial after ${sentParts} sent part${sentParts === 1 ? "" : "s"}; automatic replay was suppressed.`,
      { cause },
    );
    this.name = "PartialTelegramDeliveryError";
  }
}

function provider(value: string): DeliveryProvider {
  if (
    value === "aws_end_user_messaging_rcs" ||
    value === "slack_cloudflare_edge" ||
    value === "slack_edge" ||
    value === "teams_bot_framework" ||
    value === "telegram"
  ) {
    return value;
  }
  throw new Error("Channel delivery provider is unsupported.");
}

export function deliveryCommand(message: DeliveryMessage, delivery: Delivery): DeliveryCommand {
  if (delivery.data.credentialRef === undefined || delivery.data.providerPayload === undefined) {
    throw new Error("Channel delivery command data is unavailable.");
  }
  return {
    ...message,
    ...(delivery.data.bindingId ? { channelBindingId: delivery.data.bindingId } : {}),
    payload: delivery.data.providerPayload,
    provider: provider(delivery.data.provider),
    reference: delivery.data.credentialRef,
  };
}

export async function sendSlackDelivery(token: string, payload: unknown) {
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    body: JSON.stringify(payload),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    method: "POST",
  });
  let body: {
    error?: string;
    message?: { readonly ts?: string };
    ok?: boolean;
    ts?: string;
  };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    throw new SlackDeliveryError(
      response.ok
        ? "Slack delivery returned an invalid success response."
        : `Slack delivery failed with HTTP ${response.status}.`,
      response.status === 429,
    );
  }
  if (!response.ok || body.ok !== true) {
    throw new SlackDeliveryError(
      `Slack delivery failed${body.error ? `: ${body.error}` : ` with HTTP ${response.status}`}.`,
      response.status === 429 || body.error === "ratelimited",
    );
  }
  const providerMessageId = body.ts ?? body.message?.ts;
  return providerMessageId ? { providerMessageId } : {};
}

export async function sendTelegramProviderDelivery(
  botToken: string,
  payload: TelegramDeliveryPayload,
) {
  return sendTelegramDelivery({ botToken }, payload);
}

async function sendTelegramPayloads(
  send: NonNullable<ChannelDeliveryDependencies["sendTelegram"]>,
  botToken: string,
  payload: unknown,
) {
  const payloads = Array.isArray(payload) ? payload : [payload];
  if (payloads.length === 0) throw new Error("Telegram delivery payload is empty.");
  let providerMessageId: string | undefined;
  for (const [index, part] of payloads.entries()) {
    try {
      const result = await send(botToken, part as TelegramDeliveryPayload);
      providerMessageId = result.providerMessageId ?? providerMessageId;
    } catch (cause) {
      if (index > 0) throw new PartialTelegramDeliveryError(index, cause);
      throw cause;
    }
  }
  return providerMessageId ? { providerMessageId } : {};
}

function awsRcsThrottlingRejection(cause: unknown) {
  const error = cause as {
    readonly $metadata?: { readonly httpStatusCode?: number };
    readonly $retryable?: { readonly throttling?: boolean };
    readonly name?: string;
  };
  return (
    error?.$metadata?.httpStatusCode === 429 ||
    error?.$retryable?.throttling === true ||
    ["Throttling", "ThrottlingException", "TooManyRequestsException"].includes(error?.name ?? "")
  );
}

/**
 * Teams replay is safe only when the activity was definitely not posted: the bot token request
 * failed before any activity POST, or the connector refused the POST unapplied with 429 (throttled)
 * or 401 (cached bot token rejected; a retry re-authenticates). Other connector failures after the
 * POST (5xx, timeouts, transport errors) are ambiguous, and definitive rejections and
 * `TeamsBotAuthenticationError` credential rejections cannot succeed on retry.
 */
function teamsRetryableBeforePost(cause: unknown) {
  if (!(cause instanceof TeamsConnectorError) || !cause.retryable) return false;
  return cause.stage === "authentication" || cause.status === 429 || cause.status === 401;
}

export function safeToReplayProviderFailure(cause: unknown, provider: DeliveryProvider) {
  if (provider === "aws_end_user_messaging_rcs") return awsRcsThrottlingRejection(cause);
  if (provider === "teams_bot_framework") return teamsRetryableBeforePost(cause);
  return (
    (cause instanceof TelegramApiError && cause.status === 429) ||
    (cause instanceof SlackDeliveryError && cause.safeToRetry)
  );
}

let defaultTeamsConnector: TeamsConnectorClient | undefined;

export function deliveryErrorMessage(cause: unknown) {
  return (cause instanceof Error ? cause.message : "Channel delivery failed.").slice(0, 1_000);
}

export async function prepareProviderDelivery(
  command: DeliveryCommand,
  dependencies: ChannelDeliveryDependencies,
) {
  const credential = await dependencies.readCredential(command);
  let preparedAwsRcs: PreparedAwsRcsDelivery | undefined;
  let preparedTeams:
    | { readonly credentials: TeamsBotCredentials; readonly payload: TeamsDeliveryPayload }
    | undefined;
  if (command.provider === "aws_end_user_messaging_rcs") {
    preparedAwsRcs = await (dependencies.prepareAwsRcs ?? prepareAwsRcsDelivery)({
      externalId: stringField(credential, "externalId"),
      region: stringField(credential, "region"),
      roleArn: stringField(credential, "roleArn"),
    });
  } else if (command.provider === "teams_bot_framework") {
    preparedTeams = {
      credentials: teamsBotCredentials(credential),
      payload: readTeamsDeliveryPayload(command.payload),
    };
  } else if (command.provider === "telegram") {
    stringField(credential, "botToken");
  } else {
    stringField(credential, "accessToken", "botToken");
  }
  return { credential, preparedAwsRcs, preparedTeams };
}

export async function sendProviderDelivery(
  command: DeliveryCommand,
  prepared: Awaited<ReturnType<typeof prepareProviderDelivery>>,
  dependencies: ChannelDeliveryDependencies,
) {
  if (command.provider === "aws_end_user_messaging_rcs") {
    return prepared.preparedAwsRcs!(command.payload as AwsRcsDeliveryPayload);
  }
  if (command.provider === "teams_bot_framework") {
    return sendTeamsDelivery({
      client: dependencies.teamsConnector ?? (defaultTeamsConnector ??= teamsConnectorClient()),
      credentials: prepared.preparedTeams!.credentials,
      payload: prepared.preparedTeams!.payload,
    });
  }
  return command.provider === "telegram"
    ? sendTelegramPayloads(
        dependencies.sendTelegram ?? sendTelegramProviderDelivery,
        stringField(prepared.credential, "botToken"),
        command.payload,
      )
    : (dependencies.sendSlack ?? sendSlackDelivery)(
        stringField(prepared.credential, "accessToken", "botToken"),
        command.payload,
      );
}
