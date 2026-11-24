import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { teamsConnectorClient } from "@deployments-ai/channel-adapters/teams";
import {
  makeChannelIngressDispatchPersistence,
  makeDynamoDatabase,
  makeIdGenerator,
  tableNamesFromEnvironment,
} from "@deployments-ai/db";
import { loadAwsSecretString } from "@deployments-ai/secret-store";
import {
  DEFAULT_DURABLE_STREAM_TTL_SECONDS,
  appendThreadStreamEvents,
  createDurableStreamsClientTransport,
} from "@deployments-ai/streaming";

import { prepareAwsRcsDelivery } from "./aws-rcs-delivery.ts";
import type { ChannelDeliveryDependencies } from "./delivery-contract.ts";
import { sendSlackDelivery, sendTelegramProviderDelivery } from "./delivery-providers.ts";
import { createExternalResponsePublication } from "./external-response-publication.ts";
import {
  credentialIdentityForReference,
  runtimeCredentialVault,
  vaultReference,
} from "./runtime.ts";

export const CHANNEL_DELIVERY_ENV = {
  durableAuthSecretArn: "DEPLOYMENTS_AI_DURABLE_STREAMS_AUTH_SECRET_ARN",
  durableBaseUrl: "DEPLOYMENTS_AI_DURABLE_STREAMS_URL",
} as const;

export interface ChannelDeliveryRuntimeOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly loadSecret?: typeof loadAwsSecretString;
}

export async function createChannelDeliveryRuntimeDependencies(
  options: ChannelDeliveryRuntimeOptions = {},
): Promise<ChannelDeliveryDependencies> {
  const env = options.env ?? process.env;
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const database = makeDynamoDatabase(documentClient, tableNamesFromEnvironment(env));
  const idGenerator = makeIdGenerator();
  const generateId = async () => idGenerator.generate();
  const authSecretArn = env[CHANNEL_DELIVERY_ENV.durableAuthSecretArn]?.trim();
  const durableBaseUrl = env[CHANNEL_DELIVERY_ENV.durableBaseUrl]?.trim();
  if (Boolean(authSecretArn) !== Boolean(durableBaseUrl)) {
    throw new Error("Durable Streams URL and authentication secret must be configured together.");
  }
  let externalPublication: ChannelDeliveryDependencies["externalPublication"];
  if (authSecretArn && durableBaseUrl) {
    const authToken = (await (options.loadSecret ?? loadAwsSecretString)(authSecretArn)).trim();
    if (!authToken) throw new Error("Durable Streams authentication secret is empty.");
    const transport = createDurableStreamsClientTransport({
      allowInsecurePrivateHttp: true,
      authToken,
      baseUrl: durableBaseUrl,
      createIfMissing: true,
      ttlSeconds: DEFAULT_DURABLE_STREAM_TTL_SECONDS,
    });
    externalPublication = createExternalResponsePublication({
      appendThreadEvent: async (event, signal) => {
        await appendThreadStreamEvents({
          events: [event],
          producerId: event.eventId,
          producerType: "channel",
          ...(signal ? { signal } : {}),
          scope: event,
          transport,
        });
      },
      database,
      generateId,
    });
  }
  return {
    database,
    ...(externalPublication ? { externalPublication } : {}),
    generateId,
    ingressDispatch: makeChannelIngressDispatchPersistence(database),
    async readCredential(message) {
      const scope = {
        environmentId: message.environmentId,
        organizationId: message.organizationId,
        projectId: message.projectId,
      };
      const identity = message.channelBindingId
        ? {
            ownerId: message.channelBindingId,
            purpose: "channel-runtime",
            reference: vaultReference(message.reference),
          }
        : await credentialIdentityForReference(scope, message.reference, "channel-binding", [
            "channel-runtime",
          ]);
      const secret = await (
        await runtimeCredentialVault(scope)
      ).read({
        environmentId: message.environmentId as never,
        expectedIdentity: {
          ownerId: identity.ownerId as never,
          ownerType: "channel-binding",
          projectId: message.projectId as never,
          purpose: "channel-runtime",
        },
        organizationId: message.organizationId as never,
        reference: identity.reference,
      });
      return secret.values;
    },
    prepareAwsRcs: prepareAwsRcsDelivery,
    sendSlack: sendSlackDelivery,
    sendTelegram: sendTelegramProviderDelivery,
    teamsConnector: teamsConnectorClient(),
  };
}

let dependenciesPromise: Promise<ChannelDeliveryDependencies> | undefined;

export async function cachedChannelDeliveryRuntimeDependencies(
  create: () => Promise<ChannelDeliveryDependencies> = createChannelDeliveryRuntimeDependencies,
) {
  const pending = (dependenciesPromise ??= create());
  try {
    return await pending;
  } catch (cause) {
    if (dependenciesPromise === pending) dependenciesPromise = undefined;
    throw cause;
  }
}
