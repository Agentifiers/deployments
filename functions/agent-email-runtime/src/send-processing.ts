import {
  buildAgentEmailDomainEvent,
  type AgentEmailMessageRecord,
  type AgentEmailSendQueueMessage,
} from "@deployments-ai/agent-email";
import { InboxMailErasedError, type TransactionOperation } from "@deployments-ai/db";
import { ulid } from "./runtime-input-validation.ts";

export const MAX_INLINE_ATTACHMENT_BYTES = 4 * 1024 * 1024;
export const MAX_TRANSACTIONAL_RECIPIENTS = 47;
const AGENT_EMAIL_SEND_CLAIM_FIXED_CALLER_OPERATIONS = 6;
const AGENT_EMAIL_SEND_CLAIM_GENERATED_OPERATIONS = 3;
const DYNAMODB_TRANSACTION_OPERATION_LIMIT = 100;
const SEND_LEASE_MILLISECONDS = 6 * 60 * 1_000;

export interface AgentEmailSendQueueEvent {
  readonly Records?: readonly {
    readonly body: string;
    readonly messageId: string;
  }[];
}

export interface LoadedAgentEmailSend {
  readonly claim: (claimedAt: string) => Promise<void>;
  readonly command: AgentEmailSendQueueMessage;
  readonly ineligibility?: {
    readonly failureCode: string;
    readonly failureReason: string;
    readonly prerequisites?: readonly TransactionOperation[];
  };
  readonly kind: "found";
  readonly message: AgentEmailMessageRecord;
  readonly release: (releasedAt: string) => Promise<void>;
  readonly send: () => Promise<{ readonly providerMessageId: string }>;
  readonly update: (
    message: AgentEmailMessageRecord,
    event: ReturnType<typeof buildAgentEmailDomainEvent>,
    prerequisites?: readonly TransactionOperation[],
  ) => Promise<void>;
}

export interface AgentEmailSendMainDependencies {
  readonly createEventId: (occurredAt: string, command: AgentEmailSendQueueMessage) => string;
  readonly load: (
    command: AgentEmailSendQueueMessage,
  ) => Promise<LoadedAgentEmailSend | { readonly kind: "erased" }>;
  readonly now: () => Date;
}

export function agentEmailDispatchLimitFailure(
  kind: "attachments" | "recipients",
  actual: number,
  limit: number,
) {
  if (actual <= limit) return undefined;
  return kind === "recipients"
    ? {
        failureCode: "recipient_limit_exceeded",
        failureReason: `The message exceeds the current policy limit of ${limit} unique recipients.`,
      }
    : {
        failureCode: "attachment_limit_exceeded",
        failureReason: `The message exceeds the current ${limit}-byte attachment policy limit.`,
      };
}

export function agentEmailClaimOperationLimitFailure(
  recipientCount: number,
  verificationCheckCount: number,
) {
  const operationCount =
    AGENT_EMAIL_SEND_CLAIM_FIXED_CALLER_OPERATIONS +
    recipientCount +
    verificationCheckCount +
    AGENT_EMAIL_SEND_CLAIM_GENERATED_OPERATIONS;
  if (operationCount <= DYNAMODB_TRANSACTION_OPERATION_LIMIT) return undefined;
  return {
    failureCode: "recipient_limit_exceeded",
    failureReason:
      "The verified-recipient claim exceeds DynamoDB's 100-operation transaction limit.",
  } as const;
}

const TERMINAL_SES_SEND_ERRORS = new Set([
  "AccountSuspendedException",
  "BadRequestException",
  "MailFromDomainNotVerifiedException",
  "MessageRejected",
  "NotFoundException",
  "SendingPausedException",
]);
const RETRYABLE_PRE_ACCEPTANCE_SES_SEND_ERRORS = new Set(["TooManyRequestsException"]);

function isTerminalSesSendError(cause: unknown) {
  return cause instanceof Error && TERMINAL_SES_SEND_ERRORS.has(cause.name);
}

function isRetryablePreAcceptanceSesSendError(cause: unknown) {
  return cause instanceof Error && RETRYABLE_PRE_ACCEPTANCE_SES_SEND_ERRORS.has(cause.name);
}

export function decodeAgentEmailSendQueueMessage(body: string): AgentEmailSendQueueMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    throw new Error("Agent email send command must be JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Agent email send command must be an object.");
  }
  const input = parsed as Readonly<Record<string, unknown>>;
  if (input.type !== "agent-email-send") {
    throw new Error("Agent email send command type is unsupported.");
  }
  return {
    environmentId: ulid(input.environmentId, "environmentId"),
    inboxId: ulid(input.inboxId, "inboxId"),
    messageId: ulid(input.messageId, "messageId"),
    organizationId: ulid(input.organizationId, "organizationId"),
    projectId: ulid(input.projectId, "projectId"),
    type: "agent-email-send",
  };
}

function assertLoadedSend(input: LoadedAgentEmailSend, now: Date) {
  const { command, message } = input;
  if (
    message.id !== command.messageId ||
    message.inboxId !== command.inboxId ||
    message.organizationId !== command.organizationId
  ) {
    throw new Error("Persisted agent email message does not match the queued scope.");
  }
  if (message.direction !== "outbound") {
    throw new Error("Only outbound agent email messages may enter the SES send worker.");
  }
  if (["accepted", "delivered", "bounced", "complained", "failed"].includes(message.status)) {
    return "complete" as const;
  }
  if (message.status === "received") {
    throw new Error(`Agent email message status ${message.status} is not sendable.`);
  }
  if (
    message.status === "scheduled" &&
    (!message.scheduledAt || Date.parse(message.scheduledAt) > now.getTime())
  ) {
    return "future" as const;
  }
  if (
    message.status === "sending" &&
    Date.parse(message.updatedAt) + SEND_LEASE_MILLISECONDS > now.getTime()
  ) {
    return "busy" as const;
  }
  if (message.status === "sending") return "stale" as const;
  if (!["queued", "scheduled", "sending"].includes(message.status)) {
    throw new Error(`Agent email message status ${message.status} is not sendable.`);
  }
  return "send" as const;
}

export async function processAgentEmailSend(
  command: AgentEmailSendQueueMessage,
  dependencies: AgentEmailSendMainDependencies,
) {
  const loaded = await dependencies.load(command);
  if (loaded.kind === "erased") return { disposition: "erased" as const };
  try {
    return await sendLoadedAgentEmail(command, loaded, dependencies);
  } catch (cause) {
    if (cause instanceof InboxMailErasedError) return { disposition: "erased" as const };
    throw cause;
  }
}

async function sendLoadedAgentEmail(
  command: AgentEmailSendQueueMessage,
  loaded: LoadedAgentEmailSend,
  dependencies: AgentEmailSendMainDependencies,
) {
  const now = dependencies.now();
  const disposition = assertLoadedSend(loaded, now);
  const occurredAt = now.toISOString();
  if (disposition === "busy") {
    throw new Error("The prior agent email send lease is still active.");
  }
  if (disposition !== "send" && disposition !== "stale") return { disposition };

  async function persistFailure(
    failureCode: string,
    failureReason: string,
    prerequisites: readonly TransactionOperation[] = [],
  ) {
    const failed: AgentEmailMessageRecord = {
      ...loaded.message,
      failureCode,
      failureReason,
      status: "failed",
      updatedAt: occurredAt,
    };
    await loaded.update(
      failed,
      buildAgentEmailDomainEvent({
        aggregateId: failed.id,
        eventId: dependencies.createEventId(occurredAt, command),
        eventType: "agent-email.failed",
        payload: {
          address: failed.fromAddress,
          context: {
            environmentId: command.environmentId,
            projectId: command.projectId,
          },
          direction: failed.direction,
          failureCode,
          failureReason,
          fromAddress: failed.fromAddress,
          inboxId: failed.inboxId,
          messageId: failed.id,
          occurredAt,
          organizationId: command.organizationId,
          status: failed.status,
          subject: failed.subject,
          toAddresses: failed.toAddresses,
          version: 2,
        },
      }),
      prerequisites,
    );
    return { disposition: "failed" as const };
  }

  if (disposition === "stale") {
    return persistFailure(
      "send_outcome_unknown",
      "The prior Amazon SES send outcome could not be confirmed without risking duplicate delivery.",
    );
  }
  if (loaded.ineligibility) {
    return persistFailure(
      loaded.ineligibility.failureCode,
      loaded.ineligibility.failureReason,
      loaded.ineligibility.prerequisites,
    );
  }

  await loaded.claim(occurredAt);
  let result: { readonly providerMessageId: string };
  try {
    result = await loaded.send();
    if (!result.providerMessageId.trim()) {
      throw new Error("Amazon SES did not return a provider message ID.");
    }
  } catch (cause) {
    if (isRetryablePreAcceptanceSesSendError(cause)) {
      await loaded.release(occurredAt);
      throw cause;
    }
    if (!isTerminalSesSendError(cause)) {
      // The SES request may have been accepted before an SDK/network failure became
      // observable. Keep the send claimed so an SES SEND/DELIVERY event can reconcile
      // it without a queue retry delivering the same customer email twice.
      throw cause;
    }
    return persistFailure("provider_send_failed", "Amazon SES rejected the outbound message.");
  }
  const accepted: AgentEmailMessageRecord = {
    ...loaded.message,
    acceptedAt: occurredAt,
    providerMessageId: result.providerMessageId,
    status: "accepted",
    updatedAt: occurredAt,
  };
  try {
    await loaded.update(
      accepted,
      buildAgentEmailDomainEvent({
        aggregateId: accepted.id,
        eventId: dependencies.createEventId(occurredAt, command),
        eventType: "agent-email.accepted",
        payload: {
          address: accepted.fromAddress,
          context: {
            environmentId: command.environmentId,
            projectId: command.projectId,
          },
          direction: accepted.direction,
          fromAddress: accepted.fromAddress,
          inboxId: accepted.inboxId,
          messageId: accepted.id,
          occurredAt,
          organizationId: command.organizationId,
          providerMessageId: result.providerMessageId,
          status: accepted.status,
          subject: accepted.subject,
          toAddresses: accepted.toAddresses,
          version: 2,
        },
      }),
    );
  } catch (cause) {
    console.error(
      "SES accepted an agent email whose local status needs provider-event reconciliation.",
      {
        errorType: cause instanceof Error ? cause.name : "UnknownError",
        messageId: command.messageId,
        providerMessageId: result.providerMessageId,
      },
    );
    return {
      disposition: "acceptance_pending_reconciliation" as const,
      providerMessageId: result.providerMessageId,
    };
  }
  return {
    disposition: "accepted" as const,
    providerMessageId: result.providerMessageId,
  };
}
