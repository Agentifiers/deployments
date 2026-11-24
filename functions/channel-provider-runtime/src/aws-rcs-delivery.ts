import { AssumeRoleCommand, STSClient, type AssumeRoleCommandOutput } from "@aws-sdk/client-sts";
import {
  sendAwsRcsDelivery,
  type AwsRcsDeliveryPayload,
} from "@deployments-ai/channel-adapters/aws-rcs";

export interface AwsRcsProviderCredential {
  readonly externalId: string;
  readonly region: string;
  readonly roleArn: string;
}

export type PreparedAwsRcsDelivery = (
  payload: AwsRcsDeliveryPayload,
) => Promise<{ readonly providerMessageId?: string }>;

export class RetryableAwsRcsPreSendError extends Error {
  constructor(cause: unknown) {
    super("AWS RCS role assumption temporarily failed.", { cause });
    this.name = "RetryableAwsRcsPreSendError";
  }
}

function retryableAwsRoleAssumptionFailure(cause: unknown) {
  const error = cause as {
    readonly $metadata?: { readonly httpStatusCode?: number };
    readonly $retryable?: unknown;
    readonly code?: string;
    readonly name?: string;
  };
  const status = error?.$metadata?.httpStatusCode;
  return (
    Boolean(error?.$retryable) ||
    status === 429 ||
    (typeof status === "number" && status >= 500) ||
    [
      "AbortError",
      "InternalFailure",
      "InternalServerError",
      "RequestTimeout",
      "ServiceUnavailable",
      "ServiceUnavailableException",
      "Throttling",
      "ThrottlingException",
      "TimeoutError",
    ].includes(error?.name ?? "") ||
    ["EAI_AGAIN", "ECONNRESET", "ETIMEDOUT"].includes(error?.code ?? "")
  );
}

export async function prepareAwsRcsDelivery(
  credential: AwsRcsProviderCredential,
): Promise<PreparedAwsRcsDelivery> {
  if (!/^arn:(?:aws|aws-us-gov|aws-cn):iam::\d{12}:role\/.+/u.test(credential.roleArn)) {
    throw new Error("AWS RCS delivery roleArn is invalid.");
  }
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u.test(credential.region)) {
    throw new Error("AWS RCS delivery region is invalid.");
  }
  let assumed: AssumeRoleCommandOutput;
  try {
    assumed = await new STSClient({}).send(
      new AssumeRoleCommand({
        DurationSeconds: 900,
        ExternalId: credential.externalId,
        RoleArn: credential.roleArn,
        RoleSessionName: "deployments-ai-rcs-delivery",
      }),
    );
  } catch (cause) {
    if (retryableAwsRoleAssumptionFailure(cause)) {
      throw new RetryableAwsRcsPreSendError(cause);
    }
    throw cause;
  }
  const credentials = assumed.Credentials;
  if (!credentials?.AccessKeyId || !credentials.SecretAccessKey || !credentials.SessionToken) {
    throw new Error("STS did not return a complete AWS RCS delivery session.");
  }
  const options = {
    credentials: {
      accessKeyId: credentials.AccessKeyId,
      secretAccessKey: credentials.SecretAccessKey,
      sessionToken: credentials.SessionToken,
    },
    region: credential.region,
  };
  return (payload) => sendAwsRcsDelivery(options, payload);
}
