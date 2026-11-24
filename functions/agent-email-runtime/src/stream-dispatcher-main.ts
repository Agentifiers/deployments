import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import {
  agentEmailSendRequestFromStreamRecord,
  type AgentEmailDynamoStreamEvent,
} from "@deployments-ai/db";
import { required } from "./runtime-input-validation.ts";

const SEND_QUEUE_URL_ENV = "DEPLOYMENTS_AI_AGENT_EMAIL_SEND_QUEUE_URL";

export type AgentEmailStreamDispatcher = (
  event: AgentEmailDynamoStreamEvent,
) => Promise<{ readonly batchItemFailures: readonly { readonly itemIdentifier: string }[] }>;

export function makeAgentEmailStreamDispatcher(
  sqs: SQSClient,
  sendQueueUrl: string,
  decode = agentEmailSendRequestFromStreamRecord,
): AgentEmailStreamDispatcher {
  return async (event) => {
    const failures: { readonly itemIdentifier: string }[] = [];
    for (const record of event.Records) {
      try {
        const message = await decode(record);
        if (!message) continue;
        await sqs.send(
          new SendMessageCommand({
            MessageBody: JSON.stringify(message),
            QueueUrl: sendQueueUrl,
          }),
        );
      } catch {
        failures.push({ itemIdentifier: record.dynamodb?.SequenceNumber ?? record.eventID });
        break;
      }
    }
    return { batchItemFailures: failures };
  };
}

export function createAwsAgentEmailStreamDispatcher(
  environment: NodeJS.ProcessEnv = process.env,
): AgentEmailStreamDispatcher {
  return makeAgentEmailStreamDispatcher(
    new SQSClient({}),
    required(environment, SEND_QUEUE_URL_ENV),
  );
}

let runtime: AgentEmailStreamDispatcher | undefined;

export function handleAgentEmailStream(
  event: AgentEmailDynamoStreamEvent,
  dispatch = (runtime ??= createAwsAgentEmailStreamDispatcher()),
) {
  return dispatch(event);
}

export const handler = (event: AgentEmailDynamoStreamEvent) => handleAgentEmailStream(event);
