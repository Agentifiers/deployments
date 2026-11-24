import {
  agentEmailTenantObjectPrefix,
  type AgentEmailBlobStore,
  type AgentEmailMessageRecord,
} from "@deployments-ai/agent-email";
import {
  inboxDomainRecord,
  inboxMessageRecord,
  inboxPlacementRecord,
  inboxPolicyRecord,
  inboxRecord,
  tableForItemType,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import { erasureTestDatabase, testEndUserKeys } from "@deployments-ai/db/erasure-testing";
import { describe, expect, test } from "bun:test";
import {
  ENVIRONMENT_ID,
  INBOX_ID,
  ORGANIZATION_ID,
  PROJECT_ID,
  domain,
  inbox,
  policy,
  scope,
} from "./application-service-test-support.ts";
import {
  emailWorkflow,
  INBOX_THREAD_ID,
  platformAgent,
  storedMessage,
} from "./inbound-attachments.fixture.ts";
import { reprocessAgentEmailMessage } from "./inbound-reprocessing.ts";
import {
  createAwsAgentEmailProviderEventsDependencies,
  handleAgentEmailProviderEventsQueue,
} from "./provider-events-main.ts";
import { createAwsAgentEmailSendDependencies, handleAgentEmailSendQueue } from "./send-main.ts";

const MESSAGE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FC1" as Ulid;
const THREAD_ID = "01ARZ3NDEKTSV4RRFFQ69G5FC2" as Ulid;
const OPERATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FC3" as Ulid;
const CREATED_AT = "2026-07-25T12:00:00.000Z";
const ERASED_AT = "2026-07-26T12:00:00.000Z";
const SEND_ENVIRONMENT = {
  AWS_REGION: "us-east-1",
  DEPLOYMENTS_AI_AGENT_EMAIL_BUCKET: "agent-email",
  DEPLOYMENTS_AI_AGENT_EMAIL_EVENTS_QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/1/events",
  DEPLOYMENTS_AI_AGENT_EMAIL_SEND_QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/1/send",
};

function mail(overrides: Partial<AgentEmailMessageRecord> = {}): AgentEmailMessageRecord {
  return {
    attachments: [],
    bccAddresses: [],
    ccAddresses: [],
    createdAt: CREATED_AT,
    direction: "outbound",
    fromAddress: "agent@agents.example.com",
    id: MESSAGE_ID,
    inboxId: INBOX_ID,
    organizationId: ORGANIZATION_ID,
    references: [],
    replyToAddresses: [],
    reprocessCount: 0,
    status: "queued",
    subject: "Quarterly numbers",
    textBody: "Attached.",
    threadId: THREAD_ID,
    threadKey: "<thread@agents.example.com>",
    toAddresses: ["person@example.net"],
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

const environmentRecord = withCanonicalRecordKeys({
  data: {
    createdAt: CREATED_AT,
    id: ENVIRONMENT_ID,
    kind: "production" as const,
    name: "Production",
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    slug: "production",
    status: "active" as const,
    updatedAt: CREATED_AT,
    version: 0,
  },
  itemType: "environment" as const,
}) as PlatformRecord;

function mailbox(records: readonly PlatformRecord[]) {
  const { database, fake } = erasureTestDatabase();
  for (const record of [environmentRecord, inboxRecord(scope, inbox()), ...records]) {
    fake.put(tableForItemType(record.itemType), record);
  }
  return { database, fake };
}

async function eraseMail(database: DynamoDatabaseService, messageId: string) {
  const stored = await database.getRecord(
    "execution",
    { pk: `ORG#${ORGANIZATION_ID}#INBOX#${INBOX_ID}`, sk: `INBOX-MESSAGE#${messageId}` },
    true,
  );
  if (stored?.itemType !== "inbox-message") throw new Error("No stored message to erase.");
  const owner = {
    environmentId: stored.data.environmentId,
    inboxId: stored.data.inboxId,
    operationId: OPERATION_ID,
    organizationId: stored.data.organizationId,
    projectId: stored.data.projectId,
  };
  await database.transactWrite([
    { kind: "delete", record: stored },
    {
      kind: "put",
      record: withCanonicalRecordKeys({
        data: { ...owner, erasedAt: ERASED_AT, messageId: stored.data.id },
        itemType: "inbox-message-tombstone" as const,
      }) as PlatformRecord,
    },
    {
      kind: "put",
      record: withCanonicalRecordKeys({
        data: {
          ...owner,
          createdAt: ERASED_AT,
          erasedThrough: ERASED_AT,
          inboxThreadId: stored.data.threadId!,
          updatedAt: ERASED_AT,
          version: 1,
        },
        itemType: "inbox-thread-erasure-fence" as const,
      }) as PlatformRecord,
    },
  ]);
}

function erasedBeforeFirstWrite(database: DynamoDatabaseService, messageId: string) {
  let erased = false;
  return {
    ...database,
    transactWrite: async (...input: Parameters<DynamoDatabaseService["transactWrite"]>) => {
      if (!erased) {
        erased = true;
        await eraseMail(database, messageId);
      }
      return database.transactWrite(...input);
    },
  } satisfies DynamoDatabaseService;
}

async function storedStatus(database: DynamoDatabaseService) {
  const stored = await database.getRecord(
    "execution",
    { pk: `ORG#${ORGANIZATION_ID}#INBOX#${INBOX_ID}`, sk: `INBOX-MESSAGE#${MESSAGE_ID}` },
    true,
  );
  return stored?.itemType === "inbox-message" ? stored.data.status : null;
}

describe("send worker on erased mail", () => {
  const sendable = [
    inboxDomainRecord(scope, domain({ providerManaged: true })),
    inboxPolicyRecord(scope, policy({ warmupStage: "production" })),
    inboxPlacementRecord(scope, {
      createdAt: CREATED_AT,
      dedicatedPool: false,
      id: "01ARZ3NDEKTSV4RRFFQ69G5FC4",
      isDefault: true,
      name: "Primary",
      organizationId: ORGANIZATION_ID,
      provider: "ses",
      providerMetadata: { configurationSetName: "agent-email-primary" },
      region: "us-east-1",
      status: "active",
      updatedAt: CREATED_AT,
    }),
  ];
  const command = {
    body: JSON.stringify({
      ...scope,
      inboxId: INBOX_ID,
      messageId: MESSAGE_ID,
      type: "agent-email-send",
    }),
    messageId: "sqs-send-1",
  };

  test("acknowledges a send command whose message an erasure already removed", async () => {
    const { database } = mailbox(sendable);

    expect(
      await handleAgentEmailSendQueue(
        { Records: [command] },
        createAwsAgentEmailSendDependencies(SEND_ENVIRONMENT, database),
      ),
    ).toEqual({ batchItemFailures: [] });
  });

  test("never claims mail erased after the worker loaded it", async () => {
    const { database, fake } = mailbox([...sendable, inboxMessageRecord(scope, mail(), [])]);

    expect(
      await handleAgentEmailSendQueue(
        { Records: [command] },
        createAwsAgentEmailSendDependencies(
          SEND_ENVIRONMENT,
          erasedBeforeFirstWrite(database, MESSAGE_ID),
        ),
      ),
    ).toEqual({ batchItemFailures: [] });
    expect(await storedStatus(database)).toBeNull();
    expect(fake.transactions.map((transaction) => transaction.outcome)).toEqual([
      "applied",
      "failed",
    ]);
  });
});

describe("provider events on erased mail", () => {
  const delivered = mail({
    acceptedAt: CREATED_AT,
    providerMessageId: "ses-message-1",
    status: "accepted",
  });
  const delivery = {
    body: JSON.stringify({
      delivery: { timestamp: "2026-07-25T12:05:00.000Z" },
      eventType: "Delivery",
      mail: {
        messageId: "ses-message-1",
        tags: {
          agentEmailInboxId: [INBOX_ID],
          agentEmailMessageId: [MESSAGE_ID],
          organizationId: [ORGANIZATION_ID],
        },
        timestamp: "2026-07-25T12:00:00.000Z",
      },
    }),
    messageId: "sqs-event-1",
  };

  test("applies a delivery event to mail that still exists", async () => {
    const { database } = mailbox([inboxMessageRecord(scope, delivered, [])]);

    expect(
      await handleAgentEmailProviderEventsQueue(
        { Records: [delivery] },
        createAwsAgentEmailProviderEventsDependencies({}, database),
      ),
    ).toEqual({ batchItemFailures: [] });
    expect(await storedStatus(database)).toBe("delivered");
  });

  test("acknowledges an event for mail an erasure already removed", async () => {
    const { database } = mailbox([]);

    expect(
      await handleAgentEmailProviderEventsQueue(
        { Records: [delivery] },
        createAwsAgentEmailProviderEventsDependencies({}, database),
      ),
    ).toEqual({ batchItemFailures: [] });
  });

  test("does not restore mail erased after the event loaded it", async () => {
    const { database } = mailbox([inboxMessageRecord(scope, delivered, [])]);

    expect(
      await handleAgentEmailProviderEventsQueue(
        { Records: [delivery] },
        createAwsAgentEmailProviderEventsDependencies(
          {},
          erasedBeforeFirstWrite(database, MESSAGE_ID),
        ),
      ),
    ).toEqual({ batchItemFailures: [] });
    expect(await storedStatus(database)).toBeNull();
  });
});

describe("reprocessing erased mail", () => {
  const tenantPrefix = agentEmailTenantObjectPrefix(scope);
  const raw = new TextEncoder().encode(
    [
      "From: sender@example.com",
      "To: agent@agents.example.com",
      "Message-ID: <reprocess@example.com>",
      "Subject: Reprocess me",
      'Content-Type: multipart/mixed; boundary="erasure-boundary"',
      "",
      "--erasure-boundary",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Please read the notes.",
      "--erasure-boundary",
      "Content-Type: text/plain",
      'Content-Disposition: attachment; filename="notes.txt"',
      "Content-Transfer-Encoding: base64",
      "",
      "YXR0YWNobWVudA==",
      "--erasure-boundary--",
    ].join("\r\n"),
  );
  const received = inboxMessageRecord(
    scope,
    mail({
      direction: "inbound",
      fromAddress: "sender@example.com",
      providerMessageId: "ses-inbound-1",
      rawRetentionExpiresAt: "2099-01-01T00:00:00.000Z",
      receivedAt: CREATED_AT,
      status: "received",
      subject: "Reprocess me",
      toAddresses: ["agent@agents.example.com"],
    }),
    [],
    {
      rawReference: {
        bucket: "agent-email",
        byteSize: raw.byteLength,
        contentType: "message/rfc822",
        key: `raw/${tenantPrefix}/inboxes/${INBOX_ID}/${MESSAGE_ID}.eml`,
        sha256: "0".repeat(64),
        versionId: "raw-v1",
      },
    },
  );
  const command = {
    ...scope,
    inboxId: INBOX_ID,
    messageId: MESSAGE_ID,
    reprocessId: "reprocess-1",
    type: "agent-email.reprocess",
    version: 1,
  };

  interface ObjectStore {
    readonly blobs: AgentEmailBlobStore;
    readonly created: string[];
    readonly deleted: string[];
  }

  function objects(): ObjectStore {
    const created: string[] = [];
    const deleted: string[] = [];
    return {
      blobs: {
        delete: async (key: string, _bucket?: string, versionId?: string) => {
          deleted.push(`${key}@${versionId}`);
        },
        get: async () => raw,
        put: async ({ key }: { readonly key: string }) => {
          created.push(key);
          return { created: true, versionId: `v${created.length}` };
        },
        signedGetUrl: async () => "https://example.invalid",
      },
      created,
      deleted,
    };
  }

  function runtime(database: DynamoDatabaseService, store: ObjectStore) {
    return {
      blobs: store.blobs,
      bucket: "agent-email",
      database,
      endUserKeys: testEndUserKeys,
      legacyBuckets: [],
      now: () => new Date("2026-07-27T00:00:00.000Z"),
    };
  }

  test("reprocesses mail that still exists", async () => {
    const { database } = mailbox([received]);

    expect(await reprocessAgentEmailMessage(command, runtime(database, objects()))).toBe(
      "reprocessed",
    );
  });

  test("settles a reprocess of mail an erasure already removed", async () => {
    const { database } = mailbox([]);
    const store = objects();

    expect(await reprocessAgentEmailMessage(command, runtime(database, store))).toBe("erased");
    expect(store.created).toEqual([]);
  });

  test("removes the content it uploaded when the erasure lands mid-reprocess", async () => {
    const { database } = mailbox([received]);
    const store = objects();

    expect(
      await reprocessAgentEmailMessage(
        command,
        runtime(erasedBeforeFirstWrite(database, MESSAGE_ID), store),
      ),
    ).toBe("erased");
    expect(store.created.length).toBeGreaterThan(0);
    expect(store.deleted).toEqual(store.created.map((key, index) => `${key}@v${index + 1}`));
    expect(await storedStatus(database)).toBeNull();
  });
});

describe("inbound workflow on erased mail", () => {
  test("links the turn it submits to its inbox mail", async () => {
    const agent = platformAgent("1");
    const workflow = emailWorkflow([agent]);

    const result = await workflow.deliver();

    expect(result.submissions.map(({ result: turn }) => turn.message.data.source)).toEqual([
      {
        inboxId: storedMessage.data.inboxId,
        inboxMessageCreatedAt: storedMessage.data.createdAt,
        inboxMessageId: storedMessage.data.id,
        inboxThreadId: INBOX_THREAD_ID,
        kind: "agent-email",
      },
    ]);
    expect(
      workflow.dynamo
        .items("execution")
        .filter(
          (item) =>
            item.itemType === "conversation-inbox-thread" ||
            item.itemType === "inbox-thread-conversation",
        )
        .map((item) => String(item.itemType))
        .sort(),
    ).toEqual(["conversation-inbox-thread", "inbox-thread-conversation"]);
  });

  test("submits no turn for mail an erasure removed before the workflow ran", async () => {
    const workflow = emailWorkflow([platformAgent("1")]);
    await eraseWorkflowMail(workflow.database);

    expect(await workflow.deliver()).toEqual({ ignoredBindingIds: [], submissions: [] });
    expect(workflow.storedRunCount()).toBe(0);
  });

  test("refuses the turn once an erasure fenced the mail's inbox thread", async () => {
    const agent = platformAgent("1");
    const workflow = emailWorkflow([agent]);
    await workflow.database.transactWrite([
      {
        kind: "put",
        record: withCanonicalRecordKeys({
          data: {
            createdAt: storedMessage.data.createdAt,
            environmentId: storedMessage.data.environmentId,
            erasedThrough: storedMessage.data.createdAt,
            inboxId: storedMessage.data.inboxId,
            inboxThreadId: INBOX_THREAD_ID,
            operationId: OPERATION_ID,
            organizationId: storedMessage.data.organizationId,
            projectId: storedMessage.data.projectId,
            updatedAt: storedMessage.data.createdAt,
            version: 1,
          },
          itemType: "inbox-thread-erasure-fence" as const,
        }) as PlatformRecord,
      },
    ]);

    expect(await workflow.deliver()).toEqual({
      ignoredBindingIds: [agent.binding.data.id],
      submissions: [],
    });
    expect(workflow.storedRunCount()).toBe(0);
  });
});

async function eraseWorkflowMail(database: DynamoDatabaseService) {
  const stored = await database.getRecord(
    "execution",
    { pk: storedMessage.pk, sk: storedMessage.sk },
    true,
  );
  if (stored?.itemType !== "inbox-message") throw new Error("No stored workflow message.");
  await database.transactWrite([{ kind: "delete", record: stored }]);
}
