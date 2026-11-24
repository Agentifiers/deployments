import {
  makeDynamoDatabase,
  makeOrganizationHoldReader,
  makeUniqueClaimRecord,
  makeWebhookPersistence,
  uniqueClaimRequirements,
  withCanonicalRecordKeys,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import { fakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import { makeSemanticEventRecord } from "@deployments-ai/events";
import {
  makeWebhookEndpointRecord,
  replaceWebhookEndpointRecord,
  type WebhookEndpointUpdate,
  type WebhookRequest,
  type WebhookRequestSender,
} from "@deployments-ai/webhooks";
import type { WebhookRuntimeDependencies } from "./webhook-event-handler.ts";
import type { WebhookDeliveryMessage } from "./webhook-runtime.ts";

export const ORGANIZATION_ID = "01J10000000000000000000001" as Ulid;
const PROJECT_ID = "01J10000000000000000000002" as Ulid;
export const ENVIRONMENT_ID = "01J10000000000000000000003" as Ulid;
export const ENDPOINT_ID = "01J10000000000000000000004" as Ulid;
const CREDENTIAL_ID = "01J10000000000000000000005" as Ulid;
export const SIGNING_SECRET = "harness-signing-secret";

/**
 * In-memory webhook runtime over the real DynamoDB persistence code path: records go through
 * `makeDynamoDatabase` into a document client that evaluates every condition expression, so
 * version races and create-only conflicts behave as they do in DynamoDB.
 */
export function webhookHarness(
  options: {
    readonly sender?: WebhookRequestSender;
    readonly start?: string;
    readonly vaultValues?: Readonly<Record<string, string>>;
  } = {},
) {
  const dynamo = fakeDynamoDocumentClient();
  const database = makeDynamoDatabase(dynamo.client);
  const persistence = makeWebhookPersistence(database);
  let clock = Date.parse(options.start ?? "2026-07-20T00:00:00.000Z");
  let nextId = 0;
  const enqueued: WebhookDeliveryMessage[] = [];
  const visibility: { readonly receiptHandle: string; readonly seconds: number }[] = [];
  const requests: WebhookRequest[] = [];
  const responses: (() => Response | Promise<Response>)[] = [];
  const recordingSender: WebhookRequestSender = {
    send: async (request) => {
      requests.push(request);
      const respond = responses.shift();
      return respond ? respond() : new Response(null, { status: 204 });
    },
  };
  const put = (record: PlatformRecord, table: "control" | "events") => dynamo.put(table, record);
  put(
    withCanonicalRecordKeys({
      data: {
        createdAt: new Date(clock).toISOString(),
        id: ORGANIZATION_ID,
        name: "Harness",
        slug: "harness",
        status: "active",
        updatedAt: new Date(clock).toISOString(),
        version: 1,
      },
      itemType: "organization",
    }) as PlatformRecord,
    "control",
  );
  const dependencies: WebhookRuntimeDependencies = {
    changeVisibility: async (receiptHandle, seconds) => {
      visibility.push({ receiptHandle, seconds });
    },
    credentialVault: {
      read: async () => ({
        createdAt: new Date(clock).toISOString(),
        generation: 0,
        schemaVersion: 1,
        updatedAt: new Date(clock).toISOString(),
        values: options.vaultValues ?? { signingSecret: SIGNING_SECRET },
      }),
    } as unknown as WebhookRuntimeDependencies["credentialVault"],
    // Crockford base32 counter: valid, ordered ULIDs for claim and event IDs.
    generateId: async () =>
      `01J2${Array.from((nextId++).toString(32).padStart(22, "0"))
        .map((digit) => "0123456789ABCDEFGHJKMNPQRSTVWXYZ"[Number.parseInt(digit, 32)])
        .join("")}` as Ulid,
    now: () => new Date(clock),
    persistence,
    queue: { enqueue: async (messages) => void enqueued.push(...messages) },
    random: () => 1,
    retentionDays: 30,
    sender: options.sender ?? recordingSender,
    standing: makeOrganizationHoldReader(database),
  };
  return {
    advanceTo(instant: string | number) {
      clock = typeof instant === "number" ? instant : Date.parse(instant);
    },
    advanceBy(milliseconds: number) {
      clock += milliseconds;
    },
    database,
    dependencies,
    dynamo,
    enqueued,
    now: () => new Date(clock),
    persistence,
    requests,
    respondWith(...next: (() => Response | Promise<Response>)[]) {
      responses.push(...next);
    },
    seedEndpoint(
      overrides: { readonly url?: string; readonly update?: WebhookEndpointUpdate } = {},
    ) {
      const created = makeWebhookEndpointRecord({
        environmentId: ENVIRONMENT_ID,
        eventTypes: ["run.completed"],
        id: ENDPOINT_ID,
        name: "Harness endpoint",
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        quotaSlot: 0,
        signingSecretRef: { credentialId: CREDENTIAL_ID, generation: 0, store: "dynamodb-kms" },
        url: overrides.url ?? "https://hooks.example.com/platform",
        now: new Date(clock),
      });
      const endpoint = overrides.update
        ? replaceWebhookEndpointRecord(created, overrides.update)
        : created;
      put(endpoint, "control");
      put(
        makeUniqueClaimRecord(
          uniqueClaimRequirements(endpoint)[0]!,
          new Date(clock).toISOString(),
        ) as PlatformRecord,
        "control",
      );
      return endpoint;
    },
    seedEvent(aggregateId: Ulid, eventId: Ulid, eventType = "run.completed") {
      const event = makeSemanticEventRecord({
        aggregateId,
        aggregateType: "run",
        aggregateVersion: 1,
        environmentId: ENVIRONMENT_ID,
        eventId,
        eventType,
        occurredAt: new Date(clock),
        organizationId: ORGANIZATION_ID,
        payload: { status: "completed" },
        projectId: PROJECT_ID,
      });
      put(event, "events");
      return event;
    },
    visibility,
  };
}

/** Wraps queue messages the way the Lambda SQS event source delivers them. */
export function sqsEvent(messages: readonly WebhookDeliveryMessage[]) {
  return {
    Records: messages.map((message, index) => ({
      body: JSON.stringify(message),
      messageId: `message-${index}`,
      receiptHandle: `receipt-${index}`,
    })),
  };
}
