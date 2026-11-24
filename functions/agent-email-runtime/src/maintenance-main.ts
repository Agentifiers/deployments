import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { AgentEmailSendQueueMessage } from "@deployments-ai/agent-email";
import { makeAgentEmailAwsRuntime } from "@deployments-ai/agent-email/aws";
import {
  key,
  makeAgentEmailDynamoRepository,
  makeDynamoDatabase,
  makeIdGenerator,
  purgeExpiredAgentEmailRawObjects,
  tableNamesFromEnvironment,
  type PlatformRecord,
  type Ulid as UlidValue,
  agentEmailMaintenanceDocumentPersistence,
  agentEmailPersistence,
} from "@deployments-ai/db";
import {
  AgentEmailMaintenanceOperationError,
  agentEmailMaintenanceLogDiagnostic,
  type AgentEmailMaintenanceOperation,
} from "./maintenance-diagnostics.ts";
import { legacyAgentEmailBuckets } from "./legacy-buckets.ts";
import { required, ulid } from "./runtime-input-validation.ts";

const BUCKET_ENV = "DEPLOYMENTS_AI_AGENT_EMAIL_BUCKET";
const SEND_QUEUE_URL_ENV = "DEPLOYMENTS_AI_AGENT_EMAIL_SEND_QUEUE_URL";
const MAINTENANCE_CURSOR_KEY = {
  pk: "SYSTEM#AGENT-EMAIL#MAINTENANCE",
  sk: "SCOPE-CURSOR",
} as const;
const MAX_MAINTENANCE_RETRY_SCOPES = 1_000;

export interface AgentEmailMaintenanceCommand {
  readonly environmentId: string;
  readonly limit: number;
  readonly organizationId: string;
  readonly projectId: string;
  readonly sendEnabled?: boolean;
}

export interface AgentEmailMaintenanceSweep {
  readonly limit: number;
}

type MaintenanceCursorKey = Readonly<Record<string, string>>;

export interface AgentEmailMaintenanceScopeCursor {
  readonly organization?: {
    readonly environmentStartKey?: MaintenanceCursorKey;
    readonly id: string;
    readonly nextOrganizationStartKey?: MaintenanceCursorKey;
    readonly sendEnabled: boolean;
  };
  readonly organizationStartKey?: MaintenanceCursorKey;
}

interface AgentEmailMaintenanceScopePage {
  readonly items: readonly PlatformRecord[];
  readonly lastEvaluatedKey?: Record<string, unknown>;
}

export interface AgentEmailMaintenanceDependencies {
  readonly cleanup: (
    command: AgentEmailMaintenanceCommand,
    now: Date,
  ) => Promise<{ readonly cleaned: number }>;
  readonly enqueue: (message: Omit<AgentEmailSendQueueMessage, "type">) => Promise<void>;
  readonly listDue: (
    command: AgentEmailMaintenanceCommand,
    now: string,
  ) => Promise<readonly Omit<AgentEmailSendQueueMessage, "type">[]>;
  readonly listScopes: (limit: number) => Promise<{
    readonly commit: (failedScopes: readonly AgentEmailMaintenanceCommand[]) => Promise<void>;
    readonly scopes: readonly AgentEmailMaintenanceCommand[];
  }>;
  readonly now: () => Date;
  readonly purge: (
    command: AgentEmailMaintenanceCommand,
    now: Date,
  ) => Promise<{ readonly purged: number }>;
}

function cursorKey(value: Readonly<Record<string, unknown>> | undefined) {
  if (!value) return undefined;
  const entries = Object.entries(value);
  if (
    entries.length === 0 ||
    entries.length > 8 ||
    entries.some(
      ([key, entry]) => key.length === 0 || key.length > 128 || typeof entry !== "string",
    )
  ) {
    throw new Error("Agent email maintenance cursor contains an invalid DynamoDB key.");
  }
  return Object.fromEntries(entries) as MaintenanceCursorKey;
}

function decodeMaintenanceScopeCursor(
  value: unknown,
): AgentEmailMaintenanceScopeCursor | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > 32_768) {
    throw new Error("Agent email maintenance cursor is invalid.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Agent email maintenance cursor is invalid.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Agent email maintenance cursor is invalid.");
  }
  const candidate = parsed as Readonly<Record<string, unknown>>;
  const organizationStartKey =
    candidate.organizationStartKey === undefined
      ? undefined
      : cursorKey(candidate.organizationStartKey as Readonly<Record<string, unknown>>);
  if (candidate.organization === undefined) {
    return organizationStartKey ? { organizationStartKey } : undefined;
  }
  if (
    organizationStartKey ||
    !candidate.organization ||
    typeof candidate.organization !== "object" ||
    Array.isArray(candidate.organization)
  ) {
    throw new Error("Agent email maintenance cursor is invalid.");
  }
  const organization = candidate.organization as Readonly<Record<string, unknown>>;
  const environmentStartKey =
    organization.environmentStartKey === undefined
      ? undefined
      : cursorKey(organization.environmentStartKey as Readonly<Record<string, unknown>>);
  const nextOrganizationStartKey =
    organization.nextOrganizationStartKey === undefined
      ? undefined
      : cursorKey(organization.nextOrganizationStartKey as Readonly<Record<string, unknown>>);
  if (organization.sendEnabled !== undefined && typeof organization.sendEnabled !== "boolean") {
    throw new Error("Agent email maintenance cursor is invalid.");
  }
  return {
    organization: {
      ...(environmentStartKey ? { environmentStartKey } : {}),
      id: ulid(organization.id, "maintenance cursor organizationId"),
      ...(nextOrganizationStartKey ? { nextOrganizationStartKey } : {}),
      sendEnabled: organization.sendEnabled === true,
    },
  };
}

function decodeMaintenanceRetryScopes(value: unknown) {
  if (value === undefined) return [] as AgentEmailMaintenanceCommand[];
  if (!Array.isArray(value) || value.length > MAX_MAINTENANCE_RETRY_SCOPES) {
    throw new Error("Agent email maintenance retry scopes are invalid.");
  }
  return value.map((entry) => {
    const command = decodeAgentEmailMaintenanceCommand(entry);
    if (!("organizationId" in command)) {
      throw new Error("Agent email maintenance retry scopes are invalid.");
    }
    const sendEnabled = (entry as Readonly<Record<string, unknown>>).sendEnabled;
    if (sendEnabled !== undefined && typeof sendEnabled !== "boolean") {
      throw new Error("Agent email maintenance retry scopes are invalid.");
    }
    return {
      ...command,
      limit: 1,
      ...(typeof sendEnabled === "boolean" ? { sendEnabled } : {}),
    };
  });
}

function maintenanceScopeKey(scope: AgentEmailMaintenanceCommand) {
  return `${scope.organizationId}\u0000${scope.projectId}\u0000${scope.environmentId}`;
}

function uniqueMaintenanceScopes(scopes: readonly AgentEmailMaintenanceCommand[]) {
  const unique = new Map<string, AgentEmailMaintenanceCommand>();
  for (const scope of scopes) unique.set(maintenanceScopeKey(scope), scope);
  return [...unique.values()];
}

export async function listAgentEmailMaintenanceScopeBatch(
  limit: number,
  initialCursor: AgentEmailMaintenanceScopeCursor | undefined,
  query: (input: {
    readonly ExclusiveStartKey?: MaintenanceCursorKey;
    readonly ExpressionAttributeNames: Readonly<Record<string, string>>;
    readonly ExpressionAttributeValues: Readonly<Record<string, unknown>>;
    readonly IndexName: string;
    readonly KeyConditionExpression: string;
    readonly Limit: number;
  }) => Promise<AgentEmailMaintenanceScopePage>,
) {
  const scopes: AgentEmailMaintenanceCommand[] = [];
  let cursor = initialCursor;
  let queryCount = 0;
  const queryLimit = limit * 2 + 2;
  while (scopes.length < limit && queryCount < queryLimit) {
    if (cursor?.organization) {
      const organization = cursor.organization;
      const page = await query({
        ...(organization.environmentStartKey
          ? { ExclusiveStartKey: organization.environmentStartKey }
          : {}),
        ExpressionAttributeNames: { "#pk": "gsi1pk", "#sk": "gsi1sk" },
        ExpressionAttributeValues: {
          ":pk": `ORG#${organization.id}`,
          ":sk": "ENVIRONMENT#",
        },
        IndexName: "gsi1",
        KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :sk)",
        Limit: limit - scopes.length,
      });
      queryCount += 1;
      for (const environment of page.items) {
        if (
          environment.itemType !== "environment" ||
          environment.data.organizationId !== organization.id
        ) {
          continue;
        }
        scopes.push({
          environmentId: environment.data.id,
          limit: 1,
          organizationId: organization.id,
          projectId: environment.data.projectId,
          sendEnabled: organization.sendEnabled && environment.data.status === "active",
        });
      }
      const environmentStartKey = cursorKey(page.lastEvaluatedKey);
      if (environmentStartKey) {
        cursor = { organization: { ...organization, environmentStartKey } };
      } else if (organization.nextOrganizationStartKey) {
        cursor = {
          organizationStartKey: organization.nextOrganizationStartKey,
        };
      } else {
        cursor = undefined;
        break;
      }
      continue;
    }

    const page = await query({
      ...(cursor?.organizationStartKey ? { ExclusiveStartKey: cursor.organizationStartKey } : {}),
      ExpressionAttributeNames: { "#pk": "gsi1pk", "#sk": "gsi1sk" },
      ExpressionAttributeValues: {
        ":pk": "GLOBAL#ORGANIZATIONS",
        ":sk": "ORGANIZATION#",
      },
      IndexName: "gsi1",
      KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :sk)",
      Limit: 1,
    });
    queryCount += 1;
    const nextOrganizationStartKey = cursorKey(page.lastEvaluatedKey);
    const organization = page.items.find(
      (record): record is Extract<PlatformRecord, { readonly itemType: "organization" }> =>
        record.itemType === "organization",
    );
    if (!organization) {
      if (nextOrganizationStartKey) {
        cursor = { organizationStartKey: nextOrganizationStartKey };
        continue;
      }
      cursor = undefined;
      break;
    }
    cursor = {
      organization: {
        id: organization.data.id,
        ...(nextOrganizationStartKey ? { nextOrganizationStartKey } : {}),
        sendEnabled: organization.data.status === "active",
      },
    };
  }
  return { cursor, scopes };
}

export function decodeAgentEmailMaintenanceCommand(
  value: unknown,
): AgentEmailMaintenanceCommand | AgentEmailMaintenanceSweep {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Agent email maintenance command must be an object.");
  }
  const envelope = value as Readonly<Record<string, unknown>>;
  let queuedInput: unknown;
  if ("Records" in envelope) {
    if (!Array.isArray(envelope.Records) || envelope.Records.length !== 1) {
      throw new Error("Agent email maintenance queue event must contain exactly one record.");
    }
    const record = envelope.Records[0];
    if (
      !record ||
      typeof record !== "object" ||
      Array.isArray(record) ||
      (record as Readonly<Record<string, unknown>>).eventSource !== "aws:sqs"
    ) {
      throw new Error("Agent email maintenance queue record is invalid.");
    }
    const body = (record as Readonly<Record<string, unknown>>).body;
    if (typeof body !== "string" || body.length === 0 || body.length > 32_768) {
      throw new Error("Agent email maintenance queue body is invalid.");
    }
    try {
      queuedInput = JSON.parse(body);
    } catch {
      throw new Error("Agent email maintenance queue body is invalid.");
    }
    if (!queuedInput || typeof queuedInput !== "object" || Array.isArray(queuedInput)) {
      throw new Error("Agent email maintenance queue body is invalid.");
    }
  }
  const input =
    queuedInput && typeof queuedInput === "object" && !Array.isArray(queuedInput)
      ? (queuedInput as Readonly<Record<string, unknown>>)
      : envelope.detail && typeof envelope.detail === "object" && !Array.isArray(envelope.detail)
        ? (envelope.detail as Readonly<Record<string, unknown>>)
        : envelope;
  const requestedLimit = input.limit === undefined ? 100 : input.limit;
  if (
    typeof requestedLimit !== "number" ||
    !Number.isSafeInteger(requestedLimit) ||
    requestedLimit < 1 ||
    requestedLimit > 1_000
  ) {
    throw new Error("Agent email maintenance limit must be between 1 and 1000.");
  }
  const suppliedScope = ["environmentId", "organizationId", "projectId"].filter(
    (field) => input[field] !== undefined,
  );
  if (suppliedScope.length === 0) return { limit: requestedLimit };
  if (suppliedScope.length !== 3) {
    throw new Error(
      "Agent email maintenance scope must include organizationId, projectId, and environmentId.",
    );
  }
  return {
    environmentId: ulid(input.environmentId, "environmentId"),
    limit: requestedLimit,
    organizationId: ulid(input.organizationId, "organizationId"),
    projectId: ulid(input.projectId, "projectId"),
  };
}

export async function runAgentEmailMaintenance(
  command: AgentEmailMaintenanceCommand,
  dependencies: AgentEmailMaintenanceDependencies,
) {
  const now = dependencies.now();
  const failures: Error[] = [];
  const operationFailure = (operation: AgentEmailMaintenanceOperation, cause: unknown) =>
    new AgentEmailMaintenanceOperationError(operation, cause);
  let enqueued = 0;
  if (command.sendEnabled !== false) {
    try {
      const due = await dependencies.listDue(command, now.toISOString());
      for (const message of due) {
        try {
          if (
            message.organizationId !== command.organizationId ||
            message.projectId !== command.projectId ||
            message.environmentId !== command.environmentId
          ) {
            throw new Error("Scheduled agent email message escaped the maintenance scope.");
          }
          await dependencies.enqueue(message);
          enqueued += 1;
        } catch (cause) {
          failures.push(operationFailure("enqueue", cause));
        }
      }
    } catch (cause) {
      failures.push(operationFailure("scheduled-send lookup", cause));
    }
  }
  let purged = 0;
  try {
    purged = (await dependencies.purge(command, now)).purged;
  } catch (cause) {
    failures.push(operationFailure("raw-object purge", cause));
  }
  let cleaned = 0;
  try {
    cleaned = (await dependencies.cleanup(command, now)).cleaned;
  } catch (cause) {
    failures.push(operationFailure("content cleanup", cause));
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Agent email maintenance failed ${failures.length} bounded operations.`,
    );
  }
  return { cleaned, enqueued, purged };
}

export function agentEmailDueMessageQuery(command: AgentEmailMaintenanceCommand, now: string) {
  return {
    ExpressionAttributeNames: { "#pk": "gsi2pk", "#sk": "gsi2sk" },
    ExpressionAttributeValues: {
      ":from": `${key("INBOX-MESSAGE", "scheduled")}#`,
      ":pk": `ENV#${command.environmentId}`,
      ":to": `${key("INBOX-MESSAGE", "scheduled", now)}#\uffff`,
    },
    IndexName: "gsi2",
    KeyConditionExpression: "#pk = :pk AND #sk BETWEEN :from AND :to",
    Limit: command.limit,
  };
}

export async function runAgentEmailMaintenanceSweep(
  sweep: AgentEmailMaintenanceSweep,
  dependencies: AgentEmailMaintenanceDependencies,
) {
  const batch = await dependencies.listScopes(sweep.limit);
  const scopes = batch.scopes;
  if (scopes.length > sweep.limit) {
    throw new Error("Agent email maintenance scope enumeration exceeded the global limit.");
  }
  const perScopeLimit =
    scopes.length === 0 ? sweep.limit : Math.max(1, Math.floor(sweep.limit / scopes.length));
  const failures: {
    readonly cause: unknown;
    readonly scope: AgentEmailMaintenanceCommand;
  }[] = [];
  let enqueued = 0;
  let purged = 0;
  let cleaned = 0;
  for (const listedScope of scopes) {
    try {
      const command = { ...listedScope, limit: perScopeLimit };
      const result = await runAgentEmailMaintenance(command, dependencies);
      enqueued += result.enqueued;
      purged += result.purged;
      cleaned += result.cleaned;
    } catch (cause) {
      failures.push({ cause, scope: listedScope });
    }
  }
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error("Agent email maintenance scope failed.", {
        environmentId: failure.scope.environmentId,
        error: agentEmailMaintenanceLogDiagnostic(failure.cause),
        organizationId: failure.scope.organizationId,
        projectId: failure.scope.projectId,
      });
    }
  }
  await batch.commit(failures.map((failure) => failure.scope));
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.cause),
      `Agent email maintenance sweep failed ${failures.length} environment scopes.`,
    );
  }
  return { cleaned, enqueued, purged, scopes: scopes.length };
}

export function createAwsAgentEmailMaintenanceDependencies(
  environment: NodeJS.ProcessEnv = process.env,
): AgentEmailMaintenanceDependencies {
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const tableNames = tableNamesFromEnvironment(environment);
  const database = makeDynamoDatabase(documentClient, tableNames);
  const sendQueueUrl = required(environment, SEND_QUEUE_URL_ENV);
  const aws = makeAgentEmailAwsRuntime({
    bucket: required(environment, BUCKET_ENV),
    configurationSetName: "maintenance-not-used",
    eventsQueueUrl: sendQueueUrl,
    legacyBuckets: legacyAgentEmailBuckets(environment),
    region: required(environment, "AWS_REGION"),
    sendQueueUrl,
    tenantName: "maintenance-not-used",
  });
  const ids = makeIdGenerator();
  return {
    async cleanup(command, now) {
      const repository = makeAgentEmailDynamoRepository(database, {
        environmentId: ulid(command.environmentId, "environmentId"),
        organizationId: ulid(command.organizationId, "organizationId"),
        projectId: ulid(command.projectId, "projectId"),
      });
      const pending = await repository.listPendingContentCleanups(command.limit);
      const results = await Promise.allSettled(
        pending.map(async (cleanup) => {
          await Promise.all(
            cleanup.data.references.map((reference) =>
              aws.blobs.delete(reference.key, reference.bucket, reference.versionId),
            ),
          );
          await repository.completeContentCleanup(cleanup, now.toISOString());
        }),
      );
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `Agent email maintenance failed ${failures.length} durable content cleanups.`,
        );
      }
      return { cleaned: results.length };
    },
    enqueue: (message) => aws.enqueueSend(message).then(() => undefined),
    async listDue(command, now) {
      const page = await agentEmailPersistence.find(
        database,
        "execution",
        agentEmailDueMessageQuery(command, now),
      );
      const due: Omit<AgentEmailSendQueueMessage, "type">[] = [];
      for (const record of page.items) {
        if (
          record.itemType !== "inbox-message" ||
          record.data.organizationId !== command.organizationId ||
          record.data.projectId !== command.projectId ||
          record.data.environmentId !== command.environmentId ||
          record.data.direction !== "outbound" ||
          record.data.status !== "scheduled" ||
          !record.data.scheduledAt ||
          record.data.scheduledAt > now
        ) {
          continue;
        }
        due.push({
          environmentId: command.environmentId,
          inboxId: record.data.inboxId,
          messageId: record.data.id,
          organizationId: command.organizationId,
          projectId: command.projectId,
        });
      }
      return due;
    },
    async listScopes(limit) {
      const current = await agentEmailMaintenanceDocumentPersistence.read(documentClient, {
        ConsistentRead: true,
        Key: MAINTENANCE_CURSOR_KEY,
        TableName: tableNames.control,
      });
      let currentVersion = 0;
      if (current.Item !== undefined) {
        if (
          typeof current.Item.version !== "number" ||
          !Number.isSafeInteger(current.Item.version) ||
          current.Item.version < 1
        ) {
          throw new Error("Agent email maintenance cursor version is invalid.");
        }
        currentVersion = current.Item.version;
      }
      const retryScopes = decodeMaintenanceRetryScopes(current.Item?.retryScopes);
      const retryLimit = Math.min(
        retryScopes.length,
        limit === 1 ? (currentVersion % 2 === 0 ? 1 : 0) : Math.max(1, Math.floor(limit / 2)),
      );
      const selectedRetries = retryScopes.slice(0, retryLimit);
      const deferredRetries = retryScopes.slice(retryLimit);
      const batch = await listAgentEmailMaintenanceScopeBatch(
        limit - selectedRetries.length,
        decodeMaintenanceScopeCursor(current.Item?.cursor),
        (input) => agentEmailPersistence.find(database, "control", input),
      );
      const scopes = uniqueMaintenanceScopes([...selectedRetries, ...batch.scopes]);
      const processedScopeKeys = new Set(scopes.map(maintenanceScopeKey));
      return {
        async commit(failedScopes) {
          const nextRetries = uniqueMaintenanceScopes([
            ...failedScopes,
            ...deferredRetries.filter(
              (scope) => !processedScopeKeys.has(maintenanceScopeKey(scope)),
            ),
          ]);
          if (nextRetries.length > MAX_MAINTENANCE_RETRY_SCOPES) {
            console.error("Agent email maintenance retry scope capacity exceeded.", {
              deferred: nextRetries.length - MAX_MAINTENANCE_RETRY_SCOPES,
            });
          }
          await agentEmailMaintenanceDocumentPersistence.write(documentClient, {
            ConditionExpression:
              current.Item === undefined ? "attribute_not_exists(pk)" : "#version = :version",
            ...(current.Item === undefined
              ? {}
              : {
                  ExpressionAttributeNames: { "#version": "version" },
                  ExpressionAttributeValues: { ":version": currentVersion },
                }),
            Item: {
              ...MAINTENANCE_CURSOR_KEY,
              cursor: batch.cursor ? JSON.stringify(batch.cursor) : null,
              retryScopes: nextRetries.slice(0, MAX_MAINTENANCE_RETRY_SCOPES),
              updatedAt: new Date().toISOString(),
              version: currentVersion + 1,
            },
            TableName: tableNames.control,
          });
        },
        scopes,
      };
    },
    now: () => new Date(),
    async purge(command, now) {
      const repository = makeAgentEmailDynamoRepository(database, {
        environmentId: command.environmentId as UlidValue,
        organizationId: command.organizationId as UlidValue,
        projectId: command.projectId as UlidValue,
      });
      return purgeExpiredAgentEmailRawObjects(repository, aws.blobs, {
        createEventId: () => ids.generate(),
        limit: command.limit,
        now,
      });
    },
  };
}

let runtime: AgentEmailMaintenanceDependencies | undefined;

export function handleAgentEmailMaintenance(
  event: unknown,
  dependencies = (runtime ??= createAwsAgentEmailMaintenanceDependencies()),
) {
  const command = decodeAgentEmailMaintenanceCommand(event);
  return "organizationId" in command
    ? runAgentEmailMaintenance(command, dependencies)
    : runAgentEmailMaintenanceSweep(command, dependencies);
}

export const handler = (event: unknown) => handleAgentEmailMaintenance(event);
