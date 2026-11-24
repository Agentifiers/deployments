import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createEventBridgeTimerDeleter } from "@deployments-ai/automations";
import {
  apiPersistence,
  makeConversationErasureStore,
  makeDynamoDatabase,
  Ulid,
  type IdGeneratorService,
  type TableNames,
} from "@deployments-ai/db";
import type { ConversationErasurePorts } from "@deployments-ai/governance";
import { loadAwsSecretString } from "@deployments-ai/secret-store";
import { deleteDurableThreadStream } from "@deployments-ai/streaming";
import { cancelRun } from "@deployments-ai/worker/run-mutations";
import { Schema } from "effect";
import { requiredEnvironment } from "./lambda-environment.ts";
import { makeThreadMemoryPurgeInvoker } from "./memory-search-erasure.ts";

const CONVERSATION_ERASURE_ENV = {
  durableStreamsAuthSecretArn: "DEPLOYMENTS_AI_DURABLE_STREAMS_AUTH_SECRET_ARN",
  durableStreamsUrl: "DEPLOYMENTS_AI_DURABLE_STREAMS_URL",
  schedulerGroup: "DEPLOYMENTS_AI_SCHEDULER_GROUP",
} as const;

export function makeConversationErasurePorts(input: {
  readonly documentClient: DynamoDBDocumentClient;
  readonly environment: NodeJS.ProcessEnv;
  readonly ids: IdGeneratorService;
  readonly tables: TableNames;
}): ConversationErasurePorts {
  const { documentClient, environment, ids, tables } = input;
  const durableStreamsUrl = requiredEnvironment(
    environment,
    CONVERSATION_ERASURE_ENV.durableStreamsUrl,
  );
  const durableStreamsAuthSecretArn = requiredEnvironment(
    environment,
    CONVERSATION_ERASURE_ENV.durableStreamsAuthSecretArn,
  );
  const timers = createEventBridgeTimerDeleter({
    groupName: requiredEnvironment(environment, CONVERSATION_ERASURE_ENV.schedulerGroup),
  });
  const database = makeDynamoDatabase(documentClient, tables);
  let durableStreamsAuthToken: string | undefined;
  return {
    async cancelRun({ actorId, run }) {
      await cancelRun(
        { database, generateId: async () => ids.generate() },
        {
          actorId: Schema.decodeUnknownSync(Ulid)(actorId),
          async loadRun() {
            const current = await apiPersistence.read(database, "execution", {
              pk: run.pk,
              sk: run.sk,
            });
            if (current?.itemType !== "run") {
              throw new Error("The erased thread's run is no longer readable.");
            }
            return current;
          },
        },
      );
    },
    deleteAutomationTimer: (automationId) =>
      timers.delete(Schema.decodeUnknownSync(Ulid)(automationId)),
    async deleteThreadStream(thread) {
      durableStreamsAuthToken ??= await loadAwsSecretString(durableStreamsAuthSecretArn);
      await deleteDurableThreadStream(
        {
          allowInsecurePrivateHttp: true,
          authToken: durableStreamsAuthToken,
          baseUrl: durableStreamsUrl,
        },
        thread,
      );
    },
    purgeThreadMemories: makeThreadMemoryPurgeInvoker(environment),
    store: makeConversationErasureStore(documentClient, tables),
  };
}
