import { DynamoDBDocumentClient, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { Effect, Schema } from "effect";
import { Ulid } from "./ids.ts";
import { Keys } from "./keys.ts";
import { decodePlatformRecord, withCanonicalRecordKeys } from "./records/index.ts";

export const ORG_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAV");
export const PROJECT_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAW");
export const ENVIRONMENT_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAX");
export const EVENT_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAY");
const REPLACEMENT_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAZ");

/** Answers every read with no item, so writers find no shard-writes marker and use `legacy`. */
export function recordingClient() {
  const commands: unknown[] = [];
  const transactions: TransactWriteCommand[] = [];
  const client = {
    send: async (command: unknown) => {
      commands.push(command);
      if (command instanceof TransactWriteCommand) transactions.push(command);
      return {};
    },
  } as unknown as DynamoDBDocumentClient;

  return { client, commands, transactions };
}

/** The read of the shard-writes marker that precedes a transaction writing a locator. */
export function shardWritesMarkerRead(controlTable = "control") {
  return {
    input: {
      ConsistentRead: true,
      Key: {
        pk: "GLOBAL#deploy-migration",
        sk: "DEPLOY-MIGRATION#governance-inventory-shard-writes",
      },
      TableName: controlTable,
    },
  };
}

/** The keys of the condition checks a transaction sends to the organization's own partition. */
export function organizationConditionKeys(
  command: TransactWriteCommand,
  organizationId: string = ORG_ID,
) {
  return (command.input.TransactItems ?? []).flatMap((item) =>
    item.ConditionCheck?.Key?.pk === `ORG#${organizationId}` ? [item.ConditionCheck.Key] : [],
  );
}

export const TENANT_GATE_LANE_CONDITION =
  "attribute_exists(pk) AND (attribute_not_exists(#gate.#gateFence) OR #gate.#gateFence.#gateFenceLease <= :gateObservedAt)";

export async function organizationRecord(slug = "deployments-ai", version = 1) {
  return Effect.runPromise(
    decodePlatformRecord(
      withCanonicalRecordKeys({
        data: {
          createdAt: "2026-07-20T00:00:00.000Z",
          id: ORG_ID,
          name: "Deployments.ai",
          slug,
          status: "active",
          updatedAt: "2026-07-20T00:00:00.000Z",
          version,
        },
        itemType: "organization",
      }),
    ),
  );
}

export async function semanticEventRecord(aggregateVersion = 1) {
  return Effect.runPromise(
    decodePlatformRecord(
      withCanonicalRecordKeys({
        data: {
          aggregateId: ORG_ID,
          aggregateType: "organization",
          aggregateVersion,
          environmentId: ENVIRONMENT_ID,
          eventId: EVENT_ID,
          eventType: "organization.created",
          occurredAt: "2026-07-20T00:00:00.000Z",
          organizationId: ORG_ID,
          payload: {},
          projectId: PROJECT_ID,
        },
        itemType: "semantic-event",
      }),
    ),
  );
}

export async function auditEventRecord() {
  return Effect.runPromise(
    decodePlatformRecord(
      withCanonicalRecordKeys({
        data: {
          action: "organization.created",
          actor: { id: PROJECT_ID, type: "principal" },
          environmentId: ENVIRONMENT_ID,
          eventId: EVENT_ID,
          occurredAt: "2026-07-20T00:00:00.000Z",
          organizationId: ORG_ID,
          projectId: PROJECT_ID,
        },
        itemType: "audit-event",
      }),
    ),
  );
}

export async function runtimeLeaseRecord() {
  return Effect.runPromise(
    decodePlatformRecord(
      withCanonicalRecordKeys({
        data: {
          acquiredAt: "2026-07-20T00:00:00.000Z",
          environmentId: ENVIRONMENT_ID,
          expiresAt: "2026-07-20T00:15:00.000Z",
          id: EVENT_ID,
          leaseKey: `agent-run-thread/${EVENT_ID}`,
          organizationId: ORG_ID,
          owner: "worker:test",
          projectId: PROJECT_ID,
          runId: REPLACEMENT_ID,
          threadId: EVENT_ID,
          version: 0,
        },
        itemType: "runtime-lease",
      }),
    ),
  );
}

export async function principalIdempotencyCompletionRecord() {
  const expiresAt = "2026-07-21T00:00:00.000Z";
  return Effect.runPromise(
    decodePlatformRecord(
      withCanonicalRecordKeys({
        data: {
          commandHash: "command-hash",
          createdAt: "2026-07-20T00:00:00.000Z",
          expiresAt,
          idempotencyKey: "principal-request",
          organizationId: ORG_ID,
          principalId: PROJECT_ID,
          resourceIds: [ORG_ID],
          response: { kind: "value", value: { id: ORG_ID } },
          responseEncoding: "protected-envelope-v1",
          status: "completed",
          version: 1,
        },
        itemType: "idempotency",
        ttl: Math.floor(Date.parse(expiresAt) / 1_000),
      }),
    ),
  );
}

export async function oauthAuthorizationAttemptRecord(
  version: number,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  const expiresAt = "2026-07-21T00:00:00.000Z";
  return Effect.runPromise(
    decodePlatformRecord(
      withCanonicalRecordKeys({
        data: {
          createdAt: "2026-07-20T00:00:00.000Z",
          environmentId: ENVIRONMENT_ID,
          expiresAt,
          id: EVENT_ID,
          organizationId: ORG_ID,
          principalId: PROJECT_ID,
          projectId: PROJECT_ID,
          providerApplicationId: REPLACEMENT_ID,
          providerKey: "github",
          requestedScopes: ["repo", "user:email"],
          returnTo: "https://app.example.com/settings/connections",
          stateHash: "sha256:oauth-state",
          status: "pending",
          ...overrides,
          version,
        },
        itemType: "oauth-authorization-attempt",
        ttl: Math.floor(Date.parse(expiresAt) / 1_000),
      }),
    ),
  );
}

export async function uniqueClaimRecord(value = "deployments-ai") {
  const owner = await organizationRecord();
  const recordKey = Keys.control.uniqueClaim("organization-slug", value);
  return Effect.runPromise(
    decodePlatformRecord(
      withCanonicalRecordKeys({
        data: {
          createdAt: "2026-07-20T00:00:00.000Z",
          namespace: "organization-slug",
          ownerId: ORG_ID,
          ownerItemType: "organization",
          ownerPk: owner.pk,
          ownerSk: owner.sk,
          ownerTable: "control",
          value,
        },
        itemType: "unique-claim",
        ...recordKey,
      }),
    ),
  );
}
