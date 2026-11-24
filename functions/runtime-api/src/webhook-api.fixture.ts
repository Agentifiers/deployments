import type { KMSClient } from "@aws-sdk/client-kms";
import { GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  ApiCredentialRecord,
  ServiceAccountRecord,
  WebhookDeliveryAttemptRecord,
  WebhookDeliveryRecord,
  makeCredentialVault,
  makeUniqueClaimRecord,
  uniqueClaimRequirements,
  withCanonicalRecordKeys,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import {
  makeWebhookEndpointRecord,
  type WebhookDelivery,
  type WebhookEndpoint,
  type WebhookRequestSender,
} from "@deployments-ai/webhooks";
import { Schema } from "effect";
import { createRuntimeApiHandler } from "./runtime-handler.ts";
import { memoryDatabase, now, principal } from "./runtime-lifecycle.fixture.ts";
import type { RuntimeHumanPrincipal } from "./runtime-principal.ts";
import { credentialHash, type RuntimeApiDependencies } from "./runtime-support.ts";
import type { WebhookDeliveryMessage } from "./webhook-runtime.ts";

export { now };

let ulidSequence = 0;
/** Fresh deterministic ULIDs; the `G6` infix keeps them apart from the lifecycle fixture IDs. */
function nextUlid() {
  ulidSequence += 1;
  return `01ARZ3NDEKTSV4RRFFQ69G6${String(ulidSequence).padStart(3, "0")}` as Ulid;
}

const API_TOKEN = "dpl_test_webhook_api_credential";
const HUMAN_TOKEN = "header.payload.signature";

type DeliveryData = WebhookDelivery["data"];

export function webhookApiFixture(
  options: {
    readonly credentialScopes?: readonly string[];
    readonly humanRole?: RuntimeHumanPrincipal["organizationRole"];
    readonly webhookDeliveryQueue?: false;
    readonly webhookSender?: WebhookRequestSender;
  } = {},
) {
  const caller = principal();
  const scope = caller.scope;
  const common = {
    ...scope,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    version: 0,
  };
  const scopes = options.credentialScopes ?? ["webhooks:read", "webhooks:write"];
  const account = Schema.decodeUnknownSync(ServiceAccountRecord)(
    withCanonicalRecordKeys({
      data: { ...common, id: nextUlid(), name: "Webhook service", scopes, status: "active" },
      itemType: "service-account",
    }),
  );
  const credential = Schema.decodeUnknownSync(ApiCredentialRecord)(
    withCanonicalRecordKeys({
      data: {
        ...common,
        credentialHash: credentialHash(API_TOKEN),
        id: nextUlid(),
        keyPrefix: "dpl_test",
        name: "Webhook credential",
        scopes,
        serviceAccountId: account.data.id,
        status: "active",
      },
      itemType: "api-credential",
    }),
  );
  const credentialClaim = makeUniqueClaimRecord(
    uniqueClaimRequirements(credential)[0]!,
    now.toISOString(),
  ) as PlatformRecord;
  const memory = memoryDatabase([account, credential, credentialClaim]);
  const recordKey = (record: Pick<PlatformRecord, "pk" | "sk">) => `${record.pk}\n${record.sk}`;
  const { queryRecords: queryMemory, transactWrite: transactMemory } = memory.database;
  // Versioned puts and create-only puts conflict like DynamoDB conditional writes; queries
  // return items in sort-key order so "latest first" reads see the newest event.
  const database = {
    ...memory.database,
    queryRecords: (async (table, input) => {
      const page = await queryMemory(table, input);
      const sortKey = (record: PlatformRecord) =>
        (input.IndexName === "gsi2" ? record.gsi2sk : record.sk) ?? "";
      const items = page.items.toSorted((left, right) =>
        sortKey(left).localeCompare(sortKey(right)),
      );
      return { ...page, items: input.ScanIndexForward === false ? items.toReversed() : items };
    }) as typeof memory.database.queryRecords,
    transactWrite: (async (operations) => {
      for (const operation of operations) {
        if (operation.kind === "condition-check") continue;
        const current = memory.records.get(recordKey(operation.record));
        const previous = operation.kind === "put" ? operation.previousRecord : operation.record;
        const actual = current && "version" in current.data ? current.data.version : undefined;
        const expected = previous && "version" in previous.data ? previous.data.version : undefined;
        if (previous ? !current || actual !== expected : current !== undefined) {
          const conflict = new Error("simulated conditional conflict");
          conflict.name = "ConditionalCheckFailedException";
          throw conflict;
        }
      }
      return transactMemory(operations);
    }) as typeof memory.database.transactWrite,
  };
  const vault = makeCredentialVault({
    documentClient: {
      async send(command: unknown) {
        if (!(command instanceof GetCommand)) throw new Error("Only vault reads are expected.");
        const key = command.input.Key!;
        return { Item: memory.records.get(`${key.pk}\n${key.sk}`) };
      },
    } as unknown as DynamoDBDocumentClient,
    kmsClient: {
      async send(command: object) {
        const key = Buffer.alloc(32, 7);
        return command.constructor.name === "GenerateDataKeyCommand"
          ? { CiphertextBlob: Buffer.from("wrapped-key"), Plaintext: key }
          : { Plaintext: key };
      },
    } as unknown as KMSClient,
    kmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/test",
    tableName: "control",
  });
  const enqueued: WebhookDeliveryMessage[] = [];
  const clock = { now };
  const dependencies = {
    authenticateHuman: async () =>
      ({
        kind: "human",
        organizationRole: options.humanRole ?? "member",
        platformAdministrator: false,
        principalId: nextUlid(),
        scope,
        scopes: ["webhooks:read", "webhooks:write"],
      }) satisfies RuntimeHumanPrincipal,
    credentialVault: vault,
    database,
    generateId: async () => nextUlid(),
    now: () => clock.now,
    sessionTokenSecret: "webhook-cursor-secret",
    ...(options.webhookDeliveryQueue === false
      ? {}
      : {
          webhookDeliveryQueue: {
            enqueue: async (messages: readonly WebhookDeliveryMessage[]) => {
              enqueued.push(...messages);
            },
          },
        }),
    ...(options.webhookSender ? { webhookSender: options.webhookSender } : {}),
  } as unknown as RuntimeApiDependencies;
  const handler = createRuntimeApiHandler(dependencies);
  const request = async (
    method: string,
    path: string,
    body?: Readonly<Record<string, unknown>>,
    as: "api-credential" | "human" = "api-credential",
  ) => {
    const url = new URL(path, "https://api.example.test");
    const result = await handler({
      ...(body ? { body: JSON.stringify(body) } : {}),
      headers: {
        authorization: `Bearer ${as === "human" ? HUMAN_TOKEN : API_TOKEN}`,
        "x-deployments-environment": scope.environmentId,
        "x-deployments-organization": scope.organizationId,
        "x-deployments-project": scope.projectId,
      },
      queryStringParameters: Object.fromEntries(url.searchParams),
      rawPath: url.pathname,
      requestContext: { http: { method } },
    });
    return { body: JSON.parse(result.body) as Record<string, unknown>, status: result.statusCode };
  };
  const put = (record: PlatformRecord) => memory.records.set(recordKey(record), record);
  const read = <T extends PlatformRecord>(record: T) => memory.records.get(recordKey(record)) as T;

  function seedEndpoint(
    overrides: {
      readonly data?: Partial<WebhookEndpoint["data"]>;
      readonly secretsManager?: boolean;
    } = {},
  ) {
    const created = makeWebhookEndpointRecord({
      environmentId: scope.environmentId,
      eventTypes: ["run.completed"],
      id: nextUlid(),
      name: "Seeded endpoint",
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      signingSecretRef: overrides.secretsManager
        ? {
            arn: "arn:aws:secretsmanager:us-east-1:123456789012:secret:webhook-signing",
            versionStage: "AWSCURRENT",
          }
        : { credentialId: nextUlid(), generation: 0, store: "dynamodb-kms" },
      url: "https://hooks.example.com/platform",
      now,
    });
    const endpoint = withCanonicalRecordKeys({
      ...created,
      data: { ...created.data, ...overrides.data },
    }) as WebhookEndpoint;
    put(endpoint);
    return endpoint;
  }

  function seedDelivery(webhookEndpointId: Ulid, data: Partial<DeliveryData> = {}) {
    const delivery = Schema.decodeUnknownSync(WebhookDeliveryRecord)(
      withCanonicalRecordKeys({
        data: {
          ...common,
          aggregateId: nextUlid(),
          aggregateType: "run",
          aggregateVersion: 2,
          attempt: 3,
          eventId: nextUlid(),
          eventType: "run.completed",
          id: nextUlid(),
          lastAttemptAt: now.toISOString(),
          maxAttempts: 3,
          retentionExpiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
          status: "failed",
          webhookEndpointId,
          ...data,
        },
        itemType: "webhook-delivery",
        ttl: Math.floor((now.getTime() + 86_400_000) / 1_000),
      }),
    );
    put(delivery);
    return delivery;
  }

  function seedAttempt(delivery: WebhookDelivery, attempt: number) {
    const record = Schema.decodeUnknownSync(WebhookDeliveryAttemptRecord)(
      withCanonicalRecordKeys({
        data: {
          ...common,
          attempt,
          completedAt: now.toISOString(),
          durationMs: 12,
          eventId: delivery.data.eventId,
          id: nextUlid(),
          manual: false,
          outcome: "retrying",
          responseCode: 503,
          retentionExpiresAt: delivery.data.retentionExpiresAt,
          startedAt: now.toISOString(),
          webhookDeliveryId: delivery.data.id,
          webhookEndpointId: delivery.data.webhookEndpointId,
        },
        itemType: "webhook-delivery-attempt",
        ttl: Math.floor(Date.parse(delivery.data.retentionExpiresAt) / 1_000),
      }),
    );
    put(record);
    return record;
  }

  return {
    caller,
    clock,
    dependencies,
    enqueued,
    memory,
    read,
    request,
    seedAttempt,
    seedDelivery,
    seedEndpoint,
    vault,
  };
}
