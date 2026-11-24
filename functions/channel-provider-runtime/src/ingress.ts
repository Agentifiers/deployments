import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  asRecord,
  readString,
  type NormalizedChannelIngressRequest,
} from "@deployments-ai/channel-adapters";
import {
  awsRcsIngressRequestFromNotification,
  verifyAwsRcsIngressSignature,
} from "@deployments-ai/channel-adapters/aws-rcs";
import {
  SlackEventsApiError,
  slackEventsApiActionFromRequest,
} from "@deployments-ai/channel-adapters/slack";
import {
  TeamsIngressError,
  teamsActivityActionFromRequest,
  teamsBotCredentials,
  teamsBotFrameworkTokenVerifier,
  type TeamsBotFrameworkTokenVerifier,
} from "@deployments-ai/channel-adapters/teams";
import {
  telegramIngressRequestFromUpdate,
  verifyTelegramWebhookSecret,
} from "@deployments-ai/channel-adapters/telegram";
import {
  ChannelBindingRecord,
  key,
  channelProviderDocumentPersistence,
  makeChannelIngressBurstPersistence,
  makeDynamoDatabase,
  tableNamesFromEnvironment,
  type ChannelIngressBurstPersistence,
} from "@deployments-ai/db";
import { Effect, Schema } from "effect";

import {
  channelIngressBurstStageInput,
  channelIngressQueueMessage,
  channelIngressQueueTransport,
  decodeChannelIngressQueueMessage,
  type ChannelIngressQueueMessageV1,
} from "./ingress-message.ts";
export * from "./ingress-message.ts";

import { readChannelCredentialValues, type ChannelBinding } from "./channel-credentials.ts";
import { runtimeScopedDocumentClient, stringField } from "./runtime.ts";

const INGRESS_QUEUE_URL_ENV = "DEPLOYMENTS_AI_CHANNEL_INGRESS_QUEUE_URL";
const AWS_RCS_FORWARD_EVENT_TYPES = new Set([
  "CONVERSATION_STARTED",
  "MEDIA",
  "RCS_TYPING",
  "SUGGESTION",
  "TEXT",
]);

export interface HttpApiEventLike {
  readonly body?: string | null;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly isBase64Encoded?: boolean;
  readonly pathParameters?: Readonly<Record<string, string | undefined>>;
}

let sqsClient: SQSClient | undefined;
let ingressBurstPersistence: ChannelIngressBurstPersistence | undefined;
let teamsTokenVerifier: TeamsBotFrameworkTokenVerifier | undefined;

export interface ChannelIngressDependencies {
  readonly enqueue: (message: ChannelIngressQueueMessageV1) => Promise<void>;
  readonly loadBinding: (event: HttpApiEventLike) => Promise<ChannelBinding>;
  readonly readCredentialValues: (
    binding: ChannelBinding,
  ) => Promise<Readonly<Record<string, string>>>;
  readonly teamsTokenVerifier: TeamsBotFrameworkTokenVerifier;
}

/**
 * The provider's authenticity could not be checked (for example Bot Framework signing metadata is
 * unreachable). Answered with a 5xx so the provider redelivers instead of dropping the message.
 */
export class ChannelIngressVerificationUnavailableError extends Error {
  constructor(cause: unknown) {
    super("Channel provider request verification is temporarily unavailable.", { cause });
    this.name = "ChannelIngressVerificationUnavailableError";
  }
}

export interface ChannelIngressAcceptanceDependencies {
  readonly enqueueSource: (message: ChannelIngressQueueMessageV1) => Promise<void>;
  readonly stageSource: (message: ChannelIngressQueueMessageV1) => Promise<void>;
}

export async function acceptChannelIngressMessage(
  message: ChannelIngressQueueMessageV1,
  dependencies: ChannelIngressAcceptanceDependencies,
) {
  // Journal at the authenticated edge before publishing to FIFO. A flush can then see every
  // already-accepted successor even when its queue consumer is delayed or retrying.
  await dependencies.stageSource(message);
  await dependencies.enqueueSource(message);
}

function awsIngressBurstPersistence() {
  ingressBurstPersistence ??= makeChannelIngressBurstPersistence({
    database: makeDynamoDatabase(
      DynamoDBDocumentClient.from(new DynamoDBClient({}), {
        marshallOptions: { removeUndefinedValues: true },
      }),
      tableNamesFromEnvironment(process.env),
    ),
  });
  return ingressBurstPersistence;
}

export function awsRcsForwardingIdentityMatches(
  notification: unknown,
  bindingId: string,
  originationIdentity: string | undefined,
) {
  const record = asRecord(notification);
  const eventType = readString(record, "deploymentsAiEventType");
  return (
    Boolean(originationIdentity) &&
    Boolean(eventType && AWS_RCS_FORWARD_EVENT_TYPES.has(eventType)) &&
    readString(record, "deploymentsAiBindingId") === bindingId &&
    readString(record, "deploymentsAiOriginationIdentity") === originationIdentity
  );
}

function response(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

export function channelIngressErrorResponse(cause: unknown) {
  if (cause instanceof SlackEventsApiError) {
    return response(cause.status, {
      error: cause.status === 401 ? "invalid_signature" : "invalid_request",
    });
  }
  if (cause instanceof TeamsIngressError) {
    return response(cause.status, {
      error:
        cause.status === 401
          ? "invalid_signature"
          : cause.status === 403
            ? "forbidden"
            : "invalid_request",
    });
  }
  if (cause instanceof ChannelIngressVerificationUnavailableError) {
    return response(503, { error: "verification_unavailable" });
  }
  return response(400, { error: "invalid_request" });
}

function requiredPath(event: HttpApiEventLike, name: string) {
  const value = event.pathParameters?.[name]?.trim();
  if (!value) throw new Error(`Path parameter ${name} is required.`);
  return value;
}

function rawBody(event: HttpApiEventLike) {
  const body = event.body ?? "";
  return event.isBase64Encoded ? Buffer.from(body, "base64").toString("utf8") : body;
}

async function loadChannelBinding(event: HttpApiEventLike) {
  const organizationId = requiredPath(event, "organizationId");
  const environmentId = requiredPath(event, "environmentId");
  const bindingId = requiredPath(event, "bindingId");
  const result = await channelProviderDocumentPersistence.read(
    await runtimeScopedDocumentClient({
      environmentId,
      organizationId,
      projectId: "channel-binding-lookup",
    }),
    {
      ConsistentRead: true,
      Key: {
        pk: key("ORG", organizationId, "ENV", environmentId),
        sk: key("CHANNEL-BINDING", bindingId),
      },
      TableName: process.env.DEPLOYMENTS_AI_CONTROL_TABLE,
    },
  );
  if (!result.Item) throw new Error("Channel binding was not found.");
  const decoded = await Effect.runPromise(
    Schema.decodeUnknownEffect(ChannelBindingRecord)(result.Item),
  );
  if (decoded.data.status !== "active" || !decoded.data.credentialRef) {
    throw new Error("Channel binding is not active or has no credential reference.");
  }
  return decoded;
}

async function enqueue(message: ChannelIngressQueueMessageV1) {
  const queueUrl = process.env[INGRESS_QUEUE_URL_ENV]?.trim();
  if (!queueUrl) throw new Error(`${INGRESS_QUEUE_URL_ENV} is required.`);
  sqsClient ??= new SQSClient({});
  await acceptChannelIngressMessage(message, {
    enqueueSource: async (source) => {
      await sqsClient!.send(
        new SendMessageCommand({
          MessageBody: JSON.stringify(source),
          ...channelIngressQueueTransport(source),
          QueueUrl: queueUrl,
        }),
      );
    },
    stageSource: async (source) => {
      await awsIngressBurstPersistence().stage(channelIngressBurstStageInput(source));
    },
  });
}

async function teamsIngressAction(input: {
  readonly authorization: string | undefined;
  readonly body: string;
  readonly secretValues: Readonly<Record<string, string>>;
  readonly verifier: TeamsBotFrameworkTokenVerifier;
}) {
  const { appId } = teamsBotCredentials(input.secretValues);
  try {
    return await teamsActivityActionFromRequest({
      appId,
      authorization: input.authorization,
      provider: "teams_bot_framework",
      rawBody: input.body,
      verifier: input.verifier,
    });
  } catch (cause) {
    if (cause instanceof TeamsIngressError) throw cause;
    throw new ChannelIngressVerificationUnavailableError(cause);
  }
}

export async function handleChannelIngressWith(
  event: HttpApiEventLike,
  dependencies: ChannelIngressDependencies,
) {
  try {
    const record = await dependencies.loadBinding(event);
    const provider = requiredPath(event, "provider");
    if (provider !== record.data.provider) return response(404, { error: "binding_not_found" });
    const secretValues = await dependencies.readCredentialValues(record);
    const body = rawBody(event);
    let ingress: NormalizedChannelIngressRequest;
    if (provider === "aws_end_user_messaging_rcs") {
      if (
        !verifyAwsRcsIngressSignature({
          body,
          secret: stringField(secretValues, "ingressSigningSecret"),
          signature: event.headers?.["x-deployments-ai-rcs-signature"] ?? null,
          timestamp: event.headers?.["x-deployments-ai-rcs-timestamp"] ?? null,
        })
      ) {
        return response(401, { error: "invalid_signature" });
      }
      const notification: unknown = JSON.parse(body);
      if (
        !awsRcsForwardingIdentityMatches(
          notification,
          record.data.id,
          record.data.externalChannelId,
        )
      ) {
        return response(404, { error: "binding_not_found" });
      }
      const awsRcsIngress = awsRcsIngressRequestFromNotification(notification);
      if (!awsRcsIngress) return response(202, { ignored: "non_message_event" });
      ingress = awsRcsIngress;
    } else if (provider === "slack_edge" || provider === "slack_cloudflare_edge") {
      const action = slackEventsApiActionFromRequest({
        provider,
        rawBody: body,
        signature: event.headers?.["x-slack-signature"] ?? null,
        signingSecret: stringField(secretValues, "signingSecret"),
        timestamp: event.headers?.["x-slack-request-timestamp"] ?? null,
      });
      if (action.type === "url_verification") return response(200, { challenge: action.challenge });
      if (action.type === "ignored") return response(202, { ignored: action.reason });
      ingress = action.request;
    } else if (provider === "teams_bot_framework") {
      const action = await teamsIngressAction({
        authorization: event.headers?.authorization,
        body,
        secretValues,
        verifier: dependencies.teamsTokenVerifier,
      });
      if (action.type === "ignored") return response(202, { ignored: action.reason });
      ingress = action.request;
    } else if (provider === "telegram") {
      if (
        !verifyTelegramWebhookSecret({
          expectedSecret: stringField(secretValues, "webhookSecret"),
          providedSecret: event.headers?.["x-telegram-bot-api-secret-token"] ?? null,
        })
      )
        return response(401, { error: "invalid_signature" });
      const telegramIngress = telegramIngressRequestFromUpdate(JSON.parse(body), {
        botId: record.data.externalChannelId ?? stringField(secretValues, "botId"),
        ...(record.data.externalAccountId
          ? { externalAccountId: record.data.externalAccountId }
          : {}),
      });
      if (!telegramIngress) return response(202, { ignored: "unsupported_update" });
      ingress = telegramIngress;
    } else return response(404, { error: "unsupported_provider" });
    await dependencies.enqueue(
      decodeChannelIngressQueueMessage(channelIngressQueueMessage(record, ingress)),
    );
    return response(202, { accepted: true });
  } catch (cause) {
    console.error("Channel ingress failed.", {
      errorType: cause instanceof Error ? cause.name : "UnknownError",
    });
    return channelIngressErrorResponse(cause);
  }
}

export async function handleChannelIngress(event: HttpApiEventLike) {
  return handleChannelIngressWith(event, {
    enqueue,
    loadBinding: loadChannelBinding,
    readCredentialValues: readChannelCredentialValues,
    teamsTokenVerifier: (teamsTokenVerifier ??= teamsBotFrameworkTokenVerifier()),
  });
}

export const handler = handleChannelIngress;
