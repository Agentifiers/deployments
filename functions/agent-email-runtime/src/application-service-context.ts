import {
  AGENT_EMAIL_USAGE_KINDS,
  type AgentEmailAttachmentRecord,
  type AgentEmailDraftRecord,
  type AgentEmailMessageRecord,
  type AgentEmailPolicyRecord,
} from "@deployments-ai/agent-email";
import { deterministicAgentEmailUlid } from "@deployments-ai/agent-email/aws";
import {
  makeAgentEmailDynamoRepository,
  makeAgentEmailRepositoryContext,
  makeIdGenerator,
  key,
  type AgentEmailPlatformScope,
  type PlatformRecord,
  agentEmailPersistence,
} from "@deployments-ai/db";
import { type AgentEmailApiInvocation } from "./api-handler.ts";

import {
  apiError,
  attachmentFrom,
  DEFAULT_POLICY,
  domainFrom,
  draftFrom,
  inboxFrom,
  messageFrom,
  platformScope,
  requiredParameter,
  tableForEmailRecord,
  type DynamoAgentEmailApplicationServiceDependencies,
  type RecordOf,
} from "./application-service-support.ts";

type AgentEmailItemType =
  | "inbox"
  | "inbox-attachment"
  | "inbox-binding"
  | "inbox-domain"
  | "inbox-draft"
  | "inbox-message"
  | "inbox-placement"
  | "inbox-policy"
  | "inbox-recipient-verification"
  | "inbox-suppression"
  | "inbox-thread";

interface ScopedAgentEmailApplicationContext {
  readonly attachmentsFor: (messageId: string) => Promise<readonly AgentEmailAttachmentRecord[]>;
  readonly context: ReturnType<typeof makeAgentEmailRepositoryContext>;
  readonly draft: (id: string) => Promise<AgentEmailDraftRecord | undefined>;
  readonly hydrateDraft: (value: RecordOf<"inbox-draft">) => Promise<AgentEmailDraftRecord>;
  readonly hydrateMessage: (value: RecordOf<"inbox-message">) => Promise<AgentEmailMessageRecord>;
  readonly message: (id: string) => Promise<AgentEmailMessageRecord | undefined>;
  readonly record: <ItemType extends AgentEmailItemType>(
    itemType: ItemType,
    id: string,
  ) => Promise<RecordOf<ItemType> | undefined>;
  readonly records: <ItemType extends AgentEmailItemType>(
    itemType: ItemType,
  ) => Promise<readonly RecordOf<ItemType>[]>;
  readonly repository: ReturnType<typeof makeAgentEmailDynamoRepository>;
  readonly scope: AgentEmailPlatformScope;
  readonly summarizeDraft: (value: RecordOf<"inbox-draft">) => Promise<AgentEmailDraftRecord>;
  readonly summarizeMessage: (value: RecordOf<"inbox-message">) => Promise<AgentEmailMessageRecord>;
  readonly usageRecords: (input?: {
    readonly from?: string;
    readonly inboxId?: string;
    readonly kinds?: readonly (typeof AGENT_EMAIL_USAGE_KINDS)[number][];
    readonly maxRecords?: number;
    readonly to?: string;
  }) => Promise<readonly Extract<PlatformRecord, { readonly itemType: "meter-event" }>[]>;
}

function makeAgentEmailApplicationContext(
  dependencies: DynamoAgentEmailApplicationServiceDependencies,
) {
  const generatedIds = makeIdGenerator();
  const createId = async () => dependencies.createId?.() ?? generatedIds.generate();
  const now = () => (dependencies.now?.() ?? new Date()).toISOString();

  function defaultPolicy(invocation: AgentEmailApiInvocation, timestamp: string) {
    return {
      ...DEFAULT_POLICY,
      allowlist: [],
      blocklist: [],
      createdAt: timestamp,
      id: deterministicAgentEmailUlid(
        "1970-01-01T00:00:00.000Z",
        "environment-policy-v1",
        invocation.scope.organizationId,
        invocation.scope.projectId,
        invocation.scope.environmentId,
      ),
      organizationId: invocation.scope.organizationId,
      sendingStatus: "active" as const,
      updatedAt: timestamp,
      warmupStage: "sandbox" as const,
      warmupStartedAt: timestamp,
    } satisfies AgentEmailPolicyRecord;
  }

  function scoped(invocation: AgentEmailApiInvocation): ScopedAgentEmailApplicationContext {
    const scope = platformScope(invocation.scope);
    const repository = makeAgentEmailDynamoRepository(
      dependencies.database,
      scope,
      dependencies.endUserKeys,
    );
    const context = makeAgentEmailRepositoryContext(dependencies.database, scope);

    async function records<ItemType extends AgentEmailItemType>(itemType: ItemType) {
      const values = await context.allPages(`api-list-${itemType}`, (exclusiveStartKey) =>
        context.queryByEnvironment(
          dependencies.database,
          tableForEmailRecord(itemType),
          scope.environmentId,
          itemType,
          exclusiveStartKey,
        ),
      );
      return context.only(values, itemType).filter(context.inScope);
    }

    async function record<ItemType extends AgentEmailItemType>(itemType: ItemType, id: string) {
      if (itemType === "inbox") {
        return (await repository.getInbox(id)) as RecordOf<ItemType> | undefined;
      }
      if (
        [
          "inbox-binding",
          "inbox-domain",
          "inbox-placement",
          "inbox-policy",
          "inbox-recipient-verification",
          "inbox-suppression",
        ].includes(itemType)
      ) {
        return (await context.getEnvironmentRecord(
          itemType as
            | "inbox-binding"
            | "inbox-domain"
            | "inbox-placement"
            | "inbox-policy"
            | "inbox-recipient-verification"
            | "inbox-suppression",
          id,
        )) as RecordOf<ItemType> | undefined;
      }
      if (itemType === "inbox-message" || itemType === "inbox-draft") {
        const locatorRecord = await context.getEnvironmentRecord(
          "inbox-resource-locator",
          id,
          "execution",
        );
        const locator =
          locatorRecord?.itemType === "inbox-resource-locator" ? locatorRecord : undefined;
        const expectedType =
          itemType === "inbox-message"
            ? "message"
            : itemType === "inbox-draft"
              ? "draft"
              : undefined;
        if (!locator || locator.data.resourceType !== expectedType) return undefined;
        if (itemType === "inbox-message") {
          return (await context.getMessage(locator.data.inboxId, id)) as
            | RecordOf<ItemType>
            | undefined;
        }
        if (itemType === "inbox-draft") {
          return (await context.getDraft(locator.data.inboxId, id)) as
            | RecordOf<ItemType>
            | undefined;
        }
      }
      if (itemType === "inbox-attachment") {
        const partition = `ORG#${scope.organizationId}#INBOX-ATTACHMENT#${id}`;
        const result = await agentEmailPersistence.find(dependencies.database, "execution", {
          ExpressionAttributeNames: { "#pk": "gsi1pk", "#sk": "gsi1sk" },
          ExpressionAttributeValues: {
            ":pk": partition,
            ":sk": `INBOX-ATTACHMENT#${id}`,
          },
          IndexName: "gsi1",
          KeyConditionExpression: "#pk = :pk AND #sk = :sk",
          Limit: 2,
        });
        if (result.items.length !== 1) return undefined;
        const value = result.items[0];
        return (
          value?.itemType === "inbox-attachment" && value.data.id === id && context.inScope(value)
            ? value
            : undefined
        ) as RecordOf<ItemType> | undefined;
      }
      return (await records(itemType)).find(
        (value) => ((value as PlatformRecord).data as { readonly id?: string }).id === id,
      );
    }

    async function attachmentsFor(messageId: string) {
      const values = await context.allPages("api-list-message-attachments", (exclusiveStartKey) =>
        context.queryAggregate(
          dependencies.database,
          "execution",
          `ORG#${scope.organizationId}#INBOX-MESSAGE#${messageId}`,
          "inbox-attachment",
          exclusiveStartKey,
        ),
      );
      return context.only(values, "inbox-attachment").filter(context.inScope).map(attachmentFrom);
    }

    async function hydrateMessage(value: RecordOf<"inbox-message">) {
      const message = messageFrom(value, await attachmentsFor(value.data.id));
      if (!dependencies.blobs) {
        if (value.data.htmlBodyRef || value.data.textBodyRef) {
          apiError(
            503,
            "blob_storage_unavailable",
            "External message body storage is not configured.",
          );
        }
        return message;
      }
      const [htmlBody, textBody] = await Promise.all([
        value.data.htmlBodyRef
          ? dependencies.blobs
              .get(
                value.data.htmlBodyRef.key,
                value.data.htmlBodyRef.versionId,
                value.data.htmlBodyRef.bucket,
              )
              .then((body) => new TextDecoder().decode(body))
          : undefined,
        value.data.textBodyRef
          ? dependencies.blobs
              .get(
                value.data.textBodyRef.key,
                value.data.textBodyRef.versionId,
                value.data.textBodyRef.bucket,
              )
              .then((body) => new TextDecoder().decode(body))
          : undefined,
      ]);
      return {
        ...message,
        ...(htmlBody !== undefined ? { htmlBody } : {}),
        ...(textBody !== undefined ? { textBody } : {}),
      };
    }

    async function summarizeMessage(value: RecordOf<"inbox-message">) {
      const {
        htmlBody: _htmlBody,
        textBody: _textBody,
        ...summary
      } = messageFrom(value, await attachmentsFor(value.data.id));
      return summary;
    }

    async function summarizeDraft(value: RecordOf<"inbox-draft">) {
      const { htmlBody: _htmlBody, textBody: _textBody, ...summary } = draftFrom(value);
      return summary;
    }

    async function hydrateDraft(value: RecordOf<"inbox-draft">) {
      const selected = draftFrom(value);
      if (!dependencies.blobs) {
        if (value.data.htmlBodyRef || value.data.textBodyRef) {
          apiError(
            503,
            "blob_storage_unavailable",
            "External draft body storage is not configured.",
          );
        }
        return selected;
      }
      const [htmlBody, textBody] = await Promise.all([
        value.data.htmlBodyRef
          ? dependencies.blobs
              .get(
                value.data.htmlBodyRef.key,
                value.data.htmlBodyRef.versionId,
                value.data.htmlBodyRef.bucket,
              )
              .then((body) => new TextDecoder().decode(body))
          : undefined,
        value.data.textBodyRef
          ? dependencies.blobs
              .get(
                value.data.textBodyRef.key,
                value.data.textBodyRef.versionId,
                value.data.textBodyRef.bucket,
              )
              .then((body) => new TextDecoder().decode(body))
          : undefined,
      ]);
      return {
        ...selected,
        ...(htmlBody !== undefined ? { htmlBody } : {}),
        ...(textBody !== undefined ? { textBody } : {}),
      };
    }

    async function usageRecords(
      input: {
        readonly from?: string;
        readonly inboxId?: string;
        readonly kinds?: readonly (typeof AGENT_EMAIL_USAGE_KINDS)[number][];
        readonly maxRecords?: number;
        readonly to?: string;
      } = {},
    ) {
      const kinds = input.kinds ?? AGENT_EMAIL_USAGE_KINDS;
      const values: PlatformRecord[] = [];
      for (const kind of kinds) {
        let exclusiveStartKey: Record<string, unknown> | undefined;
        do {
          const remaining =
            input.maxRecords === undefined ? undefined : input.maxRecords - values.length;
          const result = await context.run(
            `api-list-agent-email-usage-${kind}`,
            agentEmailPersistence.find(dependencies.database, "usage", {
              ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
              ExpressionAttributeNames: {
                ...(input.inboxId
                  ? {
                      "#data": "data",
                      "#dimensions": "dimensions",
                      "#inboxId": "inboxId",
                    }
                  : {}),
                "#pk": "gsi2pk",
                "#sk": "gsi2sk",
              },
              ExpressionAttributeValues: {
                ":from": key(input.from ?? "0000-01-01T00:00:00.000Z"),
                ...(input.inboxId ? { ":inboxId": input.inboxId } : {}),
                ":pk": `ENV#${scope.environmentId}#METRIC#agent_email.${kind}`,
                ":to": `${key(input.to ?? "9999-12-31T23:59:59.999Z")}#\uffff`,
              },
              ...(input.inboxId
                ? { FilterExpression: "#data.#dimensions.#inboxId = :inboxId" }
                : {}),
              IndexName: "gsi2",
              KeyConditionExpression: "#pk = :pk AND #sk BETWEEN :from AND :to",
              ...(remaining === undefined || input.inboxId ? {} : { Limit: remaining + 1 }),
            }),
          );
          values.push(
            ...context
              .only(result.items, "meter-event")
              .filter(context.inScope)
              .filter(
                (record) =>
                  input.inboxId === undefined || record.data.dimensions.inboxId === input.inboxId,
              ),
          );
          if (input.maxRecords !== undefined && values.length > input.maxRecords) {
            apiError(
              400,
              "usage_result_limit_exceeded",
              `Usage results exceed ${input.maxRecords} records; request a narrower range or inbox.`,
            );
          }
          exclusiveStartKey = result.lastEvaluatedKey;
          if (
            input.maxRecords !== undefined &&
            values.length === input.maxRecords &&
            exclusiveStartKey &&
            input.inboxId === undefined
          ) {
            apiError(
              400,
              "usage_result_limit_exceeded",
              `Usage results exceed ${input.maxRecords} records; request a narrower range or inbox.`,
            );
          }
        } while (exclusiveStartKey);
      }
      return context.only(values, "meter-event").filter(context.inScope);
    }

    async function message(id: string) {
      const selected = await record("inbox-message", id);
      return selected ? hydrateMessage(selected) : undefined;
    }

    async function draft(id: string) {
      const selected = await record("inbox-draft", id);
      return selected ? hydrateDraft(selected) : undefined;
    }

    return {
      attachmentsFor,
      context,
      draft,
      hydrateDraft,
      hydrateMessage,
      summarizeDraft,
      summarizeMessage,
      message,
      record,
      records,
      repository,
      scope,
      usageRecords,
    };
  }

  async function requireInbox(
    invocation: AgentEmailApiInvocation,
    inboxId = requiredParameter(invocation, "inboxId"),
  ) {
    const { repository } = scoped(invocation);
    const value = await repository.getInbox(inboxId);
    if (!value) apiError(404, "inbox_not_found", `Inbox ${inboxId} was not found.`);
    return inboxFrom(value);
  }

  async function requireDomain(invocation: AgentEmailApiInvocation) {
    const domainId = requiredParameter(invocation, "domainId");
    const { repository } = scoped(invocation);
    const value = await repository.getDomain(domainId);
    if (!value) apiError(404, "domain_not_found", `Domain ${domainId} was not found.`);
    return domainFrom(value as RecordOf<"inbox-domain">);
  }

  async function requireMessage(invocation: AgentEmailApiInvocation, hydrateExternalized = false) {
    const messageId = requiredParameter(invocation, "messageId");
    const selected = scoped(invocation);
    const record = await selected.record("inbox-message", messageId);
    if (!record) apiError(404, "message_not_found", `Message ${messageId} was not found.`);
    return record.data.htmlBodyRef || record.data.textBodyRef
      ? hydrateExternalized
        ? selected.hydrateMessage(record)
        : selected.summarizeMessage(record)
      : selected.hydrateMessage(record);
  }

  async function requireDraft(invocation: AgentEmailApiInvocation, hydrateExternalized = false) {
    const draftId = requiredParameter(invocation, "draftId");
    const selected = scoped(invocation);
    const record = await selected.record("inbox-draft", draftId);
    if (!record) apiError(404, "draft_not_found", `Draft ${draftId} was not found.`);
    return record.data.htmlBodyRef || record.data.textBodyRef
      ? hydrateExternalized
        ? selected.hydrateDraft(record)
        : selected.summarizeDraft(record)
      : selected.hydrateDraft(record);
  }

  return {
    createId,
    defaultPolicy,
    dependencies,
    draftFrom,
    now,
    requireDomain,
    requireDraft,
    requireInbox,
    requireMessage,
    scoped,
  };
}

export type AgentEmailApplicationContext = ReturnType<typeof makeAgentEmailApplicationContext>;

export const createAgentEmailApplicationContext: (
  dependencies: DynamoAgentEmailApplicationServiceDependencies,
) => AgentEmailApplicationContext = makeAgentEmailApplicationContext;
