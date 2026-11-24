import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  fireHeartbeat,
  fireSchedule,
  type AutomationDependencies,
  type AutomationRunResult,
  type AutomationRunRequest,
} from "@deployments-ai/automations";
import {
  makeDynamoDatabase,
  makeIdGenerator,
  tableNamesFromEnvironment,
  Ulid,
  runtimeApiPersistence,
} from "@deployments-ai/db";
import {
  DEFAULT_DURABLE_STREAM_TTL_SECONDS,
  createDurableStreamsClientTransport,
} from "@deployments-ai/streaming";
import { createSqsAgentRunQueueEnqueue } from "@deployments-ai/worker/sqs";
import { loadAwsSecretString } from "@deployments-ai/secret-store";
import { Schema } from "effect";
import { appendThreadStreamEvents } from "@deployments-ai/streaming";
import {
  conversationIdempotencyRecordKey,
  createConversationService,
  transientConversationMessageMetadata,
} from "@deployments-ai/conversations";
import { key, type DynamoDatabaseService, type PlatformRecord } from "@deployments-ai/db";
import { required } from "./required-environment.ts";
import { automationRunTitle, automationSubmission } from "./runtime-support.ts";

export interface AutomationFirePayload {
  readonly agentDeploymentId?: string;
  readonly environmentId: string;
  readonly fireKey: string;
  readonly heartbeatId?: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly scheduleId?: string;
  readonly scheduleVersion?: number;
  readonly workspaceId?: string;
}

function asId(value: string | undefined, name: string) {
  try {
    return Schema.decodeUnknownSync(Ulid)(value);
  } catch {
    throw new Error(`${name} must be a canonical ULID.`);
  }
}

async function get(
  database: DynamoDatabaseService,
  table: "control" | "events" | "execution",
  pk: string,
  sk: string,
) {
  return await runtimeApiPersistence.read(database, table, { pk, sk }, true);
}

function record<T extends PlatformRecord["itemType"]>(value: PlatformRecord | undefined, type: T) {
  if (!value || value.itemType !== type) throw new Error(`${type} was not found.`);
  return value as Extract<PlatformRecord, { readonly itemType: T }>;
}

const ACTIVE_RUN_STATUSES = ["queued", "running", "waiting-for-approval", "waiting-for-tool"];
const ACTIVE_RUN_QUERY_LIMIT = 100;
const MAX_ACTIVE_RUN_QUERY_PAGES = 100;

interface CurrentAutomationRunScope {
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly workspaceId?: Ulid;
}

async function currentAutomationRun(
  database: DynamoDatabaseService,
  environmentId: Ulid,
  agentDeploymentId: Ulid,
  idempotencyKey: string,
  scope: CurrentAutomationRunScope,
  trigger: "heartbeat" | "schedule",
): Promise<AutomationRunResult | undefined> {
  const recordKey = conversationIdempotencyRecordKey({ environmentId, ...scope }, idempotencyKey);
  const idempotency = await get(database, "events", recordKey.pk, recordKey.sk);
  if (!idempotency || idempotency.itemType !== "idempotency") return undefined;
  const [threadId, runId] = idempotency.data.resourceIds;
  if (!threadId || !runId || idempotency.data.status !== "completed") return undefined;
  const run = await get(
    database,
    "execution",
    key("ORG", scope.organizationId, "THREAD", threadId),
    key("RUN", idempotencyKey),
  );
  if (
    !run ||
    run.itemType !== "run" ||
    run.data.id !== runId ||
    run.data.threadId !== threadId ||
    run.data.agentDeploymentId !== agentDeploymentId ||
    run.data.environmentId !== environmentId ||
    run.data.organizationId !== scope.organizationId ||
    run.data.projectId !== scope.projectId ||
    run.data.workspaceId !== scope.workspaceId ||
    run.data.trigger !== trigger
  ) {
    return undefined;
  }
  return { runId, threadId };
}

export async function findCurrentScheduleRun(
  database: DynamoDatabaseService,
  environmentId: Ulid,
  agentDeploymentId: Ulid,
  idempotencyKey: string,
  scope: CurrentAutomationRunScope,
) {
  return currentAutomationRun(
    database,
    environmentId,
    agentDeploymentId,
    idempotencyKey,
    scope,
    "schedule",
  );
}

async function statusHasActiveRun(
  database: DynamoDatabaseService,
  environmentId: Ulid,
  agentDeploymentId: Ulid,
  status: string,
): Promise<boolean> {
  const result = await runtimeApiPersistence.find(database, "execution", {
    ExpressionAttributeNames: { "#pk": "gsi2pk", "#sk": "gsi2sk" },
    ExpressionAttributeValues: {
      ":pk": key("ENV", environmentId, "AGENT-DEPLOYMENT", agentDeploymentId),
      ":prefix": `RUN#${status}#`,
    },
    IndexName: "gsi2",
    KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
    Limit: 1,
  });
  return result.items.some(
    (item) => item.itemType === "run" && item.data.agentDeploymentId === agentDeploymentId,
  );
}

async function legacyStatusHasActiveRun(
  database: DynamoDatabaseService,
  environmentId: Ulid,
  agentDeploymentId: Ulid,
  status: string,
): Promise<boolean> {
  let exclusiveStartKey: Readonly<Record<string, unknown>> | undefined;
  for (let page = 0; page < MAX_ACTIVE_RUN_QUERY_PAGES; page += 1) {
    const result = await runtimeApiPersistence.find(database, "execution", {
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      ExpressionAttributeNames: {
        "#data": "data",
        "#deployment": "agentDeploymentId",
        "#pk": "gsi2pk",
        "#sk": "gsi2sk",
      },
      ExpressionAttributeValues: {
        ":deployment": agentDeploymentId,
        ":pk": key("ENV", environmentId),
        ":prefix": `RUN#${status}#`,
      },
      FilterExpression: "#data.#deployment = :deployment",
      IndexName: "gsi2",
      KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
      Limit: ACTIVE_RUN_QUERY_LIMIT,
    });
    if (
      result.items.some(
        (item) => item.itemType === "run" && item.data.agentDeploymentId === agentDeploymentId,
      )
    ) {
      return true;
    }
    if (!result.lastEvaluatedKey) return false;
    exclusiveStartKey = result.lastEvaluatedKey;
  }
  throw new Error("Legacy active-run compatibility query exceeded its bounded page limit.");
}

export async function hasActiveRun(
  database: DynamoDatabaseService,
  environmentId: Ulid,
  agentDeploymentId: Ulid,
  currentRunIdempotencyKey?: string,
  currentRunScope?: CurrentAutomationRunScope,
  includeOtherActiveRuns = true,
) {
  if (currentRunIdempotencyKey && currentRunScope) {
    const currentRun = await currentAutomationRun(
      database,
      environmentId,
      agentDeploymentId,
      currentRunIdempotencyKey,
      currentRunScope,
      "heartbeat",
    );
    if (currentRun) return currentRun;
  }
  if (!includeOtherActiveRuns) return false;
  const canonicalMatches = await Promise.all(
    ACTIVE_RUN_STATUSES.map((status) =>
      statusHasActiveRun(database, environmentId, agentDeploymentId, status),
    ),
  );
  if (canonicalMatches.some(Boolean)) return true;
  const legacyMatches = await Promise.all(
    ACTIVE_RUN_STATUSES.map((status) =>
      legacyStatusHasActiveRun(database, environmentId, agentDeploymentId, status),
    ),
  );
  return legacyMatches.some(Boolean);
}

async function createAutomationFireRuntime(
  env: NodeJS.ProcessEnv = process.env,
): Promise<AutomationDependencies> {
  const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  const database = makeDynamoDatabase(documentClient, tableNamesFromEnvironment(env));
  const authToken = await loadAwsSecretString(
    required("DEPLOYMENTS_AI_DURABLE_STREAMS_AUTH_SECRET_ARN", env),
  );
  const transport = createDurableStreamsClientTransport({
    allowInsecurePrivateHttp: true,
    authToken,
    baseUrl: required("DEPLOYMENTS_AI_DURABLE_STREAMS_URL", env),
    createIfMissing: true,
    ttlSeconds: DEFAULT_DURABLE_STREAM_TTL_SECONDS,
  });
  const enqueueRun = createSqsAgentRunQueueEnqueue({
    queueUrl: required("DEPLOYMENTS_AI_AGENT_RUN_QUEUE_URL", env),
  });
  const ids = makeIdGenerator();
  const generateId = async () => ids.generate();
  const appendThreadEvent = async (
    event: Parameters<typeof appendThreadStreamEvents>[0]["events"][number],
  ) => {
    await appendThreadStreamEvents({
      events: [event],
      producerId: event.eventId,
      producerType: "api",
      scope: event,
      transport,
    });
  };
  const submitRun = async (input: AutomationRunRequest) => {
    record(
      await get(
        database,
        "control",
        key("ORG", input.organizationId, "ENV", input.environmentId),
        key("AGENT-DEPLOYMENT", input.agentDeploymentId),
      ),
      "agent-deployment",
    );
    const result = await automationSubmission(
      createConversationService({
        appendThreadEvent,
        database,
        enqueueRun,
        generateId,
      }).submitTurn({
        ...input,
        actor: { type: "system" },
        ...(input.trigger === "heartbeat" || input.trigger === "schedule"
          ? { messageMetadata: transientConversationMessageMetadata() }
          : {}),
        title: automationRunTitle(input.trigger),
      }),
    );
    return { runId: result.run.data.id, threadId: result.thread.data.id };
  };
  return { database, generateId, submitRun };
}

let runtimePromise: Promise<AutomationDependencies> | undefined;

export async function cachedAutomationFireRuntime(
  create: typeof createAutomationFireRuntime = createAutomationFireRuntime,
) {
  const pending = (runtimePromise ??= create());
  try {
    return await pending;
  } catch (cause) {
    if (runtimePromise === pending) runtimePromise = undefined;
    throw cause;
  }
}

export function createScheduleFireHandler() {
  return async (payload: AutomationFirePayload) => {
    const runtime = await cachedAutomationFireRuntime();
    return fireSchedule(
      {
        environmentId: asId(payload.environmentId, "environmentId"),
        fireKey: payload.fireKey,
        findCurrentRun: (agentDeploymentId, currentRunIdempotencyKey, workspaceId) =>
          findCurrentScheduleRun(
            runtime.database,
            asId(payload.environmentId, "environmentId"),
            agentDeploymentId,
            currentRunIdempotencyKey,
            {
              organizationId: asId(payload.organizationId, "organizationId"),
              projectId: asId(payload.projectId, "projectId"),
              ...(workspaceId ? { workspaceId } : {}),
            },
          ),
        organizationId: asId(payload.organizationId, "organizationId"),
        projectId: asId(payload.projectId, "projectId"),
        scheduleId: asId(payload.scheduleId, "scheduleId"),
        ...(payload.scheduleVersion === undefined
          ? {}
          : { scheduleVersion: payload.scheduleVersion }),
        ...(payload.workspaceId ? { workspaceId: asId(payload.workspaceId, "workspaceId") } : {}),
      },
      runtime,
    );
  };
}

export function createHeartbeatFireHandler() {
  return async (payload: AutomationFirePayload) => {
    const runtime = await cachedAutomationFireRuntime();
    return fireHeartbeat(
      {
        agentDeploymentId: asId(payload.agentDeploymentId, "agentDeploymentId"),
        environmentId: asId(payload.environmentId, "environmentId"),
        fireKey: payload.fireKey,
        heartbeatId: asId(payload.heartbeatId, "heartbeatId"),
        hasActiveRun: (
          agentDeploymentId,
          currentRunIdempotencyKey,
          workspaceId,
          includeOtherActiveRuns,
        ) =>
          hasActiveRun(
            runtime.database,
            asId(payload.environmentId, "environmentId"),
            agentDeploymentId,
            currentRunIdempotencyKey,
            {
              organizationId: asId(payload.organizationId, "organizationId"),
              projectId: asId(payload.projectId, "projectId"),
              ...(workspaceId ? { workspaceId } : {}),
            },
            includeOtherActiveRuns,
          ),
        organizationId: asId(payload.organizationId, "organizationId"),
        projectId: asId(payload.projectId, "projectId"),
        ...(payload.scheduleVersion === undefined
          ? {}
          : { scheduleVersion: payload.scheduleVersion }),
        ...(payload.workspaceId ? { workspaceId: asId(payload.workspaceId, "workspaceId") } : {}),
      },
      runtime,
    );
  };
}
