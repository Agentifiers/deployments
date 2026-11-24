import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  buildAgentEmailDomainEvent,
  type AgentEmailMessageRecord,
} from "@deployments-ai/agent-email";
import {
  agentEmailTransitionForProviderEvent,
  deterministicAgentEmailUlid,
  isSesEventDestinationValidationNotice,
  parseAgentEmailProviderEvent,
  type AgentEmailQueueRecord,
  type NormalizedAgentEmailProviderEvent,
} from "@deployments-ai/agent-email/aws";
import {
  InboxMailErasedError,
  makeAgentEmailDynamoRepository,
  makeDynamoDatabase,
  tableNamesFromEnvironment,
  type DynamoDatabaseService,
  type PlatformRecord,
  agentEmailPersistence,
} from "@deployments-ai/db";
import { syncAgentEmailMessageSuppression } from "./suppression-runtime.ts";
import { definedFields } from "./record-fields.ts";
import { ulid } from "./runtime-input-validation.ts";

export interface AgentEmailProviderEventsQueueEvent {
  readonly Records?: readonly AgentEmailQueueRecord[];
}

export interface LoadedAgentEmailProviderEvent {
  readonly event: NormalizedAgentEmailProviderEvent;
  readonly kind: "found";
  readonly message: AgentEmailMessageRecord;
  readonly scope: {
    readonly environmentId: string;
    readonly organizationId: string;
    readonly projectId: string;
  };
  readonly suppress: (input: {
    readonly addresses: readonly string[];
    readonly reason: "bounce" | "complaint";
    readonly sourceMessageId: string;
  }) => Promise<void>;
  readonly update: (
    message: AgentEmailMessageRecord,
    event: ReturnType<typeof buildAgentEmailDomainEvent>,
  ) => Promise<void>;
}

export interface AgentEmailProviderEventsMainDependencies {
  readonly load: (
    event: NormalizedAgentEmailProviderEvent,
  ) => Promise<LoadedAgentEmailProviderEvent | { readonly kind: "erased" }>;
}

function object(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function tag(payload: Readonly<Record<string, unknown>>, name: string) {
  const tags = object(object(payload.mail)?.tags);
  const value = tags?.[name];
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
}

export function agentEmailProviderSuppressionAddresses(
  event: NormalizedAgentEmailProviderEvent,
  message: AgentEmailMessageRecord,
) {
  const reason =
    event.eventType === "BOUNCE"
      ? ("bounce" as const)
      : event.eventType === "COMPLAINT"
        ? ("complaint" as const)
        : undefined;
  if (!reason) return { addresses: [], reason: undefined };
  const details = object(event.payload[reason]);
  if (
    reason === "bounce" &&
    (typeof details?.bounceType !== "string" ||
      details.bounceType.trim().toLowerCase() !== "permanent")
  ) {
    return { addresses: [], reason: undefined };
  }
  const recipients = Array.isArray(
    details?.[reason === "bounce" ? "bouncedRecipients" : "complainedRecipients"],
  )
    ? (details[reason === "bounce" ? "bouncedRecipients" : "complainedRecipients"] as unknown[])
    : [];
  const messageRecipients = new Set(
    [...message.toAddresses, ...message.ccAddresses, ...message.bccAddresses].map((address) =>
      address.trim().toLowerCase(),
    ),
  );
  const addresses = [
    ...new Set(
      recipients.flatMap((recipient) => {
        const address = object(recipient)?.emailAddress;
        if (typeof address !== "string") return [];
        const normalized = address.trim().toLowerCase();
        return normalized && messageRecipients.has(normalized) ? [normalized] : [];
      }),
    ),
  ];
  return { addresses, reason };
}

function messageModel(
  record: Extract<PlatformRecord, { readonly itemType: "inbox-message" }>,
): AgentEmailMessageRecord {
  return { ...definedFields(record.data), attachments: [] };
}

export function providerEventEnvironmentMatchesScope(
  environmentRecord:
    | PlatformRecord
    | {
        readonly data: {
          readonly id: string;
          readonly organizationId: string;
          readonly projectId: string;
          readonly status?: string;
        };
        readonly itemType: "environment";
      }
    | undefined,
  scope: {
    readonly environmentId: string;
    readonly organizationId: string;
    readonly projectId: string;
  },
) {
  // Provider callbacks reconcile already accepted mail after environment archival.
  return (
    environmentRecord?.itemType === "environment" &&
    environmentRecord.data.organizationId === scope.organizationId &&
    environmentRecord.data.projectId === scope.projectId &&
    environmentRecord.data.id === scope.environmentId
  );
}

export async function processAgentEmailProviderEvent(
  event: NormalizedAgentEmailProviderEvent,
  dependencies: AgentEmailProviderEventsMainDependencies,
) {
  const loaded = await dependencies.load(event);
  if (loaded.kind === "erased") return { disposition: "erased" as const };
  try {
    return await applyAgentEmailProviderEvent(event, loaded);
  } catch (cause) {
    if (cause instanceof InboxMailErasedError) return { disposition: "erased" as const };
    throw cause;
  }
}

async function applyAgentEmailProviderEvent(
  event: NormalizedAgentEmailProviderEvent,
  loaded: LoadedAgentEmailProviderEvent,
) {
  if (loaded.event !== event) {
    throw new Error("Loaded provider event does not match the normalized queue event.");
  }
  const taggedMessageId = event.taggedMessageId;
  const providerMessageId = event.providerMessageId;
  if (
    !taggedMessageId ||
    loaded.message.id !== taggedMessageId ||
    !providerMessageId ||
    (loaded.message.providerMessageId && loaded.message.providerMessageId !== providerMessageId)
  ) {
    throw new Error("SES provider event does not match the persisted agent email message.");
  }
  if (
    loaded.message.organizationId !== loaded.scope.organizationId ||
    loaded.message.direction !== "outbound"
  ) {
    throw new Error("SES provider event resolved outside its outbound message scope.");
  }
  const transition = agentEmailTransitionForProviderEvent(
    event.eventType,
    loaded.message.status === "failed" && loaded.message.failureCode === "send_outcome_unknown"
      ? "sending"
      : loaded.message.status,
  );
  if (!transition) return { disposition: "ignored" as const };
  const suppression = agentEmailProviderSuppressionAddresses(event, loaded.message);
  if (suppression.reason) {
    if (suppression.addresses.length === 0) {
      throw new Error("SES bounce or complaint event has no matching message recipients.");
    }
    await loaded.suppress({
      addresses: suppression.addresses,
      reason: suppression.reason,
      sourceMessageId: loaded.message.id,
    });
  }
  const {
    failureCode: _previousFailureCode,
    failureReason: _previousFailureReason,
    ...messageWithoutFailure
  } = loaded.message;
  const next: AgentEmailMessageRecord = {
    ...(transition.status === "failed" ? loaded.message : messageWithoutFailure),
    ...(transition.status === "accepted" && !loaded.message.acceptedAt
      ? { acceptedAt: event.occurredAt }
      : {}),
    ...(transition.status === "delivered" ? { deliveredAt: event.occurredAt } : {}),
    ...(transition.status === "failed"
      ? {
          failureCode: event.eventType.toLowerCase(),
          failureReason: "Amazon SES rejected or could not render the message.",
        }
      : {}),
    ...(event.internetMessageId ? { internetMessageId: event.internetMessageId } : {}),
    providerMessageId,
    status: transition.status,
    updatedAt: event.occurredAt,
  };
  await loaded.update(
    next,
    buildAgentEmailDomainEvent({
      aggregateId: next.id,
      eventId: deterministicAgentEmailUlid(
        event.occurredAt,
        "provider-event",
        event.providerEventId,
        next.id,
      ),
      eventType: transition.eventType,
      payload: {
        address: next.fromAddress,
        context: {
          environmentId: loaded.scope.environmentId,
          projectId: loaded.scope.projectId,
        },
        direction: next.direction,
        ...(next.failureCode ? { failureCode: next.failureCode } : {}),
        ...(next.failureReason ? { failureReason: next.failureReason } : {}),
        fromAddress: next.fromAddress,
        inboxId: next.inboxId,
        messageId: next.id,
        occurredAt: event.occurredAt,
        organizationId: loaded.scope.organizationId,
        providerMessageId,
        status: next.status,
        subject: next.subject,
        toAddresses: next.toAddresses,
        version: 2,
      },
    }),
  );
  return { disposition: "applied" as const, status: transition.status };
}

export function createAwsAgentEmailProviderEventsDependencies(
  environment: NodeJS.ProcessEnv = process.env,
  database: DynamoDatabaseService = makeDynamoDatabase(
    DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    }),
    tableNamesFromEnvironment(environment),
  ),
): AgentEmailProviderEventsMainDependencies {
  return {
    async load(event) {
      const organizationId = ulid(tag(event.payload, "organizationId"), "organizationId tag");
      const inboxId = ulid(tag(event.payload, "agentEmailInboxId"), "agentEmailInboxId tag");
      const messageId = ulid(event.taggedMessageId, "agentEmailMessageId tag");
      const inbox = await agentEmailPersistence.read(
        database,
        "control",
        {
          pk: `ORG#${organizationId}#INBOX#${inboxId}`,
          sk: `INBOX#${inboxId}`,
        },
        true,
      );
      if (
        inbox?.itemType !== "inbox" ||
        inbox.data.id !== inboxId ||
        inbox.data.organizationId !== organizationId
      ) {
        throw new Error("SES provider event inbox tags do not resolve to a canonical inbox.");
      }
      const environmentRecord = await agentEmailPersistence.read(
        database,
        "control",
        {
          pk: `ORG#${organizationId}#PROJECT#${inbox.data.projectId}`,
          sk: `ENVIRONMENT#${inbox.data.environmentId}`,
        },
        true,
      );
      if (
        !providerEventEnvironmentMatchesScope(environmentRecord, {
          environmentId: inbox.data.environmentId,
          organizationId,
          projectId: inbox.data.projectId,
        })
      ) {
        throw new Error("SES provider event environment does not match its inbox scope.");
      }
      const persisted = await agentEmailPersistence.read(
        database,
        "execution",
        {
          pk: `ORG#${organizationId}#INBOX#${inboxId}`,
          sk: `INBOX-MESSAGE#${messageId}`,
        },
        true,
      );
      if (!persisted) return { kind: "erased" };
      if (
        persisted.itemType !== "inbox-message" ||
        persisted.data.organizationId !== organizationId ||
        persisted.data.projectId !== inbox.data.projectId ||
        persisted.data.environmentId !== inbox.data.environmentId ||
        persisted.data.inboxId !== inboxId
      ) {
        throw new Error("SES provider event message is outside its inbox scope.");
      }
      const scope = {
        environmentId: inbox.data.environmentId,
        organizationId,
        projectId: inbox.data.projectId,
      };
      const repository = makeAgentEmailDynamoRepository(database, {
        environmentId: scope.environmentId,
        organizationId,
        projectId: scope.projectId,
      });
      return {
        event,
        kind: "found",
        message: messageModel(persisted),
        scope,
        suppress: async (input) => {
          const existing = await repository.listSuppressions();
          for (const address of input.addresses) {
            let active = existing.find(
              (candidate) =>
                candidate.data.status === "active" && candidate.data.address === address,
            );
            if (!active) {
              const removedAt = existing
                .filter((candidate) => candidate.data.address === address)
                .map((candidate) => candidate.data.removedAt ?? candidate.data.updatedAt)
                .toSorted()
                .at(-1);
              const suppression = {
                address,
                createdAt: event.occurredAt,
                id: deterministicAgentEmailUlid(
                  event.occurredAt,
                  "provider-suppression-v1",
                  event.providerEventId,
                  address,
                  removedAt ?? "",
                ),
                organizationId,
                reason: input.reason,
                sourceMessageId: input.sourceMessageId,
              };
              try {
                active = await repository.createSuppression(suppression);
                existing.push(active);
              } catch (cause) {
                active = (await repository.listSuppressions()).find(
                  (candidate) =>
                    candidate.data.status === "active" && candidate.data.address === address,
                );
                if (!active) throw cause;
              }
            }
            await syncAgentEmailMessageSuppression(repository, {
              address,
              message: messageModel(persisted),
              reason: input.reason,
              removed: false,
            });
          }
        },
        update: async (next, domainEvent) => {
          await repository.updateMessage(persisted, next, domainEvent);
        },
      };
    },
  };
}

let runtime: AgentEmailProviderEventsMainDependencies | undefined;

export async function handleAgentEmailProviderEventsQueue(
  event: AgentEmailProviderEventsQueueEvent,
  dependencies = (runtime ??= createAwsAgentEmailProviderEventsDependencies()),
) {
  const batchItemFailures: { readonly itemIdentifier: string }[] = [];
  for (const record of event.Records ?? []) {
    if (isSesEventDestinationValidationNotice(record.body)) continue;
    try {
      await processAgentEmailProviderEvent(parseAgentEmailProviderEvent(record), dependencies);
    } catch (cause) {
      console.error("Agent email provider event failed.", {
        errorType: cause instanceof Error ? cause.name : "UnknownError",
        messageId: record.messageId,
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}

export const handler = (event: AgentEmailProviderEventsQueueEvent) =>
  handleAgentEmailProviderEventsQueue(event);
