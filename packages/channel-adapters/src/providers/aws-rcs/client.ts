import {
  PinpointSMSVoiceV2Client,
  SendRcsMessageCommand,
} from "@aws-sdk/client-pinpoint-sms-voice-v2";

import { awsRcsCommandInput, type AwsRcsClientOptions } from "./types.ts";

export interface AwsRcsSendDependencies {
  readonly createClient: (options: AwsRcsClientOptions & { readonly maxAttempts: 1 }) => {
    send(command: SendRcsMessageCommand): Promise<{ readonly MessageId?: string }>;
  };
}

const defaultDependencies: AwsRcsSendDependencies = {
  createClient: (options) => new PinpointSMSVoiceV2Client(options),
};

export async function sendAwsRcsDelivery(
  client: AwsRcsClientOptions,
  payload: unknown,
  dependencies = defaultDependencies,
) {
  const response = await dependencies
    .createClient({ ...client, maxAttempts: 1 })
    .send(new SendRcsMessageCommand(awsRcsCommandInput(payload)));
  return response.MessageId ? { providerMessageId: response.MessageId } : {};
}
