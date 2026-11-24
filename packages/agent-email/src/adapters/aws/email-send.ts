import {
  SendEmailCommand,
  SESv2Client,
  type SendEmailCommandInput,
  type SendEmailCommandOutput,
} from "@aws-sdk/client-sesv2";
import { readEmailSesTenant, type EmailSesTenant } from "./email-tenant.ts";

export interface EmailSesMessage {
  readonly from: string;
  readonly to: readonly string[];
  readonly cc?: readonly string[] | undefined;
  readonly bcc?: readonly string[] | undefined;
  readonly replyTo?: readonly string[] | undefined;
  readonly subject: string;
  readonly text?: string | undefined;
  readonly html?: string | undefined;
}

const sendFailures = {
  ambiguous: {
    outcome: "ambiguous",
    status: 500,
    code: "ambiguous_write_outcome",
    message: "Email acceptance could not be determined; do not retry this send.",
  },
  rejected: {
    outcome: "rejected",
    status: 422,
    code: "email_send_rejected",
    message: "The email provider rejected this message.",
  },
  throttled: {
    outcome: "rejected",
    status: 429,
    code: "email_send_throttled",
    message: "The email provider sending limit has been reached.",
  },
  paused: {
    outcome: "rejected",
    status: 409,
    code: "email_tenant_paused",
    message: "The email tenant is paused.",
  },
  unavailable: {
    outcome: "rejected",
    status: 503,
    code: "email_provider_unavailable",
    message: "The email provider is temporarily unavailable.",
  },
} as const;

export type EmailSesSendFailure = keyof typeof sendFailures;

/** Safe to expose/log: intentionally contains neither the provider cause nor message content. */
export class EmailSesSendError extends Error {
  readonly outcome: "rejected" | "ambiguous";
  readonly status: (typeof sendFailures)[EmailSesSendFailure]["status"];
  readonly code: (typeof sendFailures)[EmailSesSendFailure]["code"];

  constructor(failure: EmailSesSendFailure) {
    const classification = sendFailures[failure];
    super(classification.message);
    this.name = "EmailSesSendError";
    this.outcome = classification.outcome;
    this.status = classification.status;
    this.code = classification.code;
  }
}

const preAcceptanceErrors: Readonly<Record<string, Exclude<EmailSesSendFailure, "ambiguous">>> = {
  AccountSuspendedException: "unavailable",
  BadRequestException: "rejected",
  ConfigurationSetDoesNotExistException: "unavailable",
  ConfigurationSetSendingPausedException: "unavailable",
  MailFromDomainNotVerifiedException: "unavailable",
  MessageRejected: "rejected",
  NotFoundException: "unavailable",
  SendingPausedException: "paused",
  TenantSendingPausedException: "paused",
  TooManyRequestsException: "throttled",
  LimitExceededException: "throttled",
  AccessDeniedException: "unavailable",
  InvalidClientTokenId: "unavailable",
  SignatureDoesNotMatch: "unavailable",
  ExpiredTokenException: "unavailable",
  CredentialsProviderError: "unavailable",
  TokenProviderError: "unavailable",
};

export function classifyEmailSesSendFailure(cause: unknown): EmailSesSendFailure {
  if (!cause || typeof cause !== "object") return "ambiguous";
  const metadata = "$metadata" in cause ? cause.$metadata : undefined;
  const status =
    metadata && typeof metadata === "object" && "httpStatusCode" in metadata
      ? metadata.httpStatusCode
      : undefined;
  if (typeof status === "number" && status >= 500) return "ambiguous";
  return "name" in cause &&
    typeof cause.name === "string" &&
    Object.hasOwn(preAcceptanceErrors, cause.name)
    ? preAcceptanceErrors[cause.name]!
    : "ambiguous";
}

const clients = new Map<string, SESv2Client>();

function send(region: string, input: SendEmailCommandInput) {
  let client = clients.get(region);
  if (!client) {
    // SendEmail has no provider idempotency token: never retry uncertain acceptance.
    client = new SESv2Client({ region, maxAttempts: 1 });
    clients.set(region, client);
  }
  return client.send(new SendEmailCommand(input));
}

export function makeEmailSesSender(
  dependencies: {
    readonly readTenant?: (tenant: EmailSesTenant) => Promise<EmailSesTenant>;
    readonly send?: (
      region: string,
      input: SendEmailCommandInput,
    ) => Promise<SendEmailCommandOutput>;
  } = {},
) {
  const readTenant =
    dependencies.readTenant ??
    ((tenant: EmailSesTenant) => readEmailSesTenant(tenant, { requireExisting: true }));
  const sendEmail = dependencies.send ?? send;
  return async (
    tenant: EmailSesTenant,
    message: EmailSesMessage,
  ): Promise<{ providerMessageId: string }> => {
    if (tenant.status !== "active") throw new EmailSesSendError("paused");
    if (!tenant.providerName || !tenant.configurationSetName) {
      throw new EmailSesSendError("unavailable");
    }
    // This read is deliberately adjacent to SendEmail and cannot reinstate an external pause.
    let native: EmailSesTenant;
    try {
      native = await readTenant(tenant);
    } catch {
      throw new EmailSesSendError("unavailable");
    }
    if (native.sendingStatus !== "enabled" && native.sendingStatus !== "reinstated") {
      throw new EmailSesSendError(native.sendingStatus === "disabled" ? "paused" : "unavailable");
    }
    try {
      const result = await sendEmail(tenant.region, {
        TenantName: tenant.providerName,
        ConfigurationSetName: tenant.configurationSetName,
        FromEmailAddress: message.from,
        Destination: {
          ToAddresses: [...message.to],
          ...(message.cc ? { CcAddresses: [...message.cc] } : {}),
          ...(message.bcc ? { BccAddresses: [...message.bcc] } : {}),
        },
        ...(message.replyTo ? { ReplyToAddresses: [...message.replyTo] } : {}),
        Content: {
          Simple: {
            Subject: { Charset: "UTF-8", Data: message.subject },
            Body: {
              ...(message.text ? { Text: { Charset: "UTF-8", Data: message.text } } : {}),
              ...(message.html ? { Html: { Charset: "UTF-8", Data: message.html } } : {}),
            },
          },
        },
      });
      if (!result.MessageId) throw new EmailSesSendError("ambiguous");
      return { providerMessageId: result.MessageId };
    } catch (cause) {
      if (cause instanceof EmailSesSendError) throw cause;
      throw new EmailSesSendError(classifyEmailSesSendFailure(cause));
    }
  };
}
