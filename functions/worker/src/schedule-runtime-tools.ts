import {
  archiveSchedule,
  AutomationError,
  createSchedule,
  getSchedule,
  type AutomationDependencies,
  type TimerProvider,
} from "@deployments-ai/automations";
import {
  key,
  type DynamoDatabaseService,
  type PlatformRecord,
  type Ulid,
  workerPersistence,
} from "@deployments-ai/db";
import {
  RuntimeToolPreparationRetryableError,
  requireAgentDeploymentId,
} from "@deployments-ai/agent-runtime";
import { Buffer } from "node:buffer";
import { decodeTime } from "ulid";
import type { ExecuteRuntimeBuiltinTool } from "./runtime-tools.ts";
import { builtinMutationClaimIdempotencyKey } from "./runtime-idempotency.ts";
import {
  jsonToolResult,
  optionalInteger,
  optionalString,
  requiredString,
  toolInput,
  ulid,
} from "./builtin-tool-support.ts";
import { deploymentOwnedBuiltin } from "./execution-tool-policy.ts";

type Schedule = Extract<PlatformRecord, { readonly itemType: "schedule" }>;
const DEFAULT_SCHEDULE_LIST_LIMIT = 25;
const MAX_SCHEDULE_LIST_LIMIT = 100;
const MAX_SCHEDULE_LIST_SCAN_RECORDS = 250;
const MAX_SCHEDULE_LIST_RESPONSE_BYTES = 512 * 1024;

export interface RuntimeScheduleToolOptions {
  readonly database: DynamoDatabaseService;
  readonly generateId: () => Promise<Ulid>;
  readonly timerProvider: TimerProvider;
}

function dependencies(options: RuntimeScheduleToolOptions): AutomationDependencies {
  return {
    database: options.database,
    generateId: options.generateId,
    submitRun: async () => {
      throw new Error("Schedule creation does not submit a run synchronously.");
    },
    timerProvider: options.timerProvider,
  };
}

function publicSchedule(record: Schedule) {
  return {
    agentDeploymentId: record.data.agentDeploymentId,
    createdAt: record.data.createdAt,
    expression: record.data.schedule.expression,
    id: record.data.id,
    name: record.data.name,
    prompt: record.data.prompt,
    status: record.data.status,
    ...(record.data.threadId ? { threadId: record.data.threadId } : {}),
    timezone: record.data.schedule.timezone,
    updatedAt: record.data.updatedAt,
  };
}

function listedSchedule(record: Schedule) {
  const prompt = record.data.prompt ?? "";
  return {
    ...publicSchedule(record),
    prompt: prompt.length <= 1_024 ? prompt : `${prompt.slice(0, 1_023)}…`,
    ...(prompt.length > 1_024 ? { promptTruncated: true } : {}),
  };
}

function scheduleExpression(input: Readonly<Record<string, unknown>>) {
  const expression = requiredString(input, "expression", 256);
  if (/^(?:at|cron|rate)\(/u.test(expression)) return expression;
  const kind = requiredString(input, "kind", 16);
  if (kind === "cron") return `cron(${expression})`;
  if (kind === "interval") return `rate(${expression})`;
  throw new TypeError("kind must be cron or interval.");
}

const KNOWN_AUTOMATION_ERRORS = new Set([
  "automation_archived",
  "deployment_unavailable",
  "idempotency_conflict",
  "invalid_request",
  "invalid_schedule",
  "invalid_timezone",
  "not_found",
  "release_unavailable",
  "scope_mismatch",
  "thread_archived",
  "trigger_not_allowed",
  "workspace_unavailable",
]);

async function automationResult<Result>(toolName: string, operation: () => Promise<Result>) {
  try {
    return await operation();
  } catch (cause) {
    if (cause instanceof AutomationError && KNOWN_AUTOMATION_ERRORS.has(cause.code)) {
      throw new TypeError(cause.message, { cause });
    }
    throw new RuntimeToolPreparationRetryableError(toolName, cause);
  }
}

async function listSchedules(
  database: DynamoDatabaseService,
  request: Parameters<ExecuteRuntimeBuiltinTool>[0],
  input: Readonly<Record<string, unknown>>,
) {
  const limit =
    optionalInteger(input, "limit", {
      maximum: MAX_SCHEDULE_LIST_LIMIT,
      minimum: 1,
    }) ?? DEFAULT_SCHEDULE_LIST_LIMIT;
  const cursor = optionalString(input, "cursor", 1_024);
  if (cursor !== undefined && !cursor.startsWith("SCHEDULE#")) {
    throw new TypeError("cursor must be a valid schedule-list cursor.");
  }
  const candidates: Array<{
    readonly record: Schedule;
    readonly sortKey: string;
  }> = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  let lastScannedSortKey: string | undefined;
  let scanned = 0;
  while (candidates.length < limit + 1 && scanned < MAX_SCHEDULE_LIST_SCAN_RECORDS) {
    let page;
    try {
      page = await workerPersistence.find(
        database,
        "control",
        {
          ExpressionAttributeNames: { "#pk": "gsi2pk", "#sk": "gsi2sk" },
          ExpressionAttributeValues: {
            ":pk": key("ENV", request.environmentId),
            ":sk": cursor ?? "SCHEDULE#",
          },
          IndexName: "gsi2",
          KeyConditionExpression: cursor
            ? "#pk = :pk AND #sk < :sk"
            : "#pk = :pk AND begins_with(#sk, :sk)",
          Limit: Math.min(100, MAX_SCHEDULE_LIST_SCAN_RECORDS - scanned),
          ScanIndexForward: false,
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        },
        request.signal,
      );
    } catch (cause) {
      throw new RuntimeToolPreparationRetryableError(request.toolName, cause);
    }
    scanned += page.items.length;
    for (const record of page.items) {
      if (record.gsi2sk) lastScannedSortKey = record.gsi2sk;
      if (
        record.itemType === "schedule" &&
        record.data.organizationId === request.organizationId &&
        record.data.projectId === request.projectId &&
        record.data.agentDeploymentId === request.agentDeploymentId &&
        record.data.workspaceId === request.workspaceId &&
        record.gsi2sk
      ) {
        candidates.push({ record, sortKey: record.gsi2sk });
        if (candidates.length >= limit + 1) break;
      }
    }
    exclusiveStartKey = page.lastEvaluatedKey;
    if (!exclusiveStartKey) break;
  }
  const scanSliceExhausted = exclusiveStartKey !== undefined && candidates.length < limit + 1;
  const schedules: ReturnType<typeof listedSchedule>[] = [];
  let responseBytes = 64;
  let responseBudgetReached = false;
  let lastSortKey: string | undefined;
  for (const candidate of candidates.slice(0, limit)) {
    const value = listedSchedule(candidate.record);
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8") + 1;
    if (responseBytes + bytes > MAX_SCHEDULE_LIST_RESPONSE_BYTES) {
      responseBudgetReached = true;
      break;
    }
    schedules.push(value);
    responseBytes += bytes;
    lastSortKey = candidate.sortKey;
  }
  const hasMore =
    responseBudgetReached || candidates.length > limit || exclusiveStartKey !== undefined;
  const nextCursor = scanSliceExhausted ? lastScannedSortKey : lastSortKey;
  return {
    ...(hasMore && nextCursor ? { nextCursor } : {}),
    schedules,
  };
}

export function scheduleCreationIdempotencyKey(
  request: Pick<
    Parameters<ExecuteRuntimeBuiltinTool>[0],
    "idempotencyKey" | "input" | "runId" | "toolName"
  >,
) {
  const claimKey = builtinMutationClaimIdempotencyKey({
    ...(request.input ? { input: request.input } : {}),
    requestIdempotencyKey: request.idempotencyKey,
    runId: request.runId,
    toolName: request.toolName,
  });
  return claimKey === request.idempotencyKey
    ? `${request.runId}:${request.idempotencyKey}`
    : claimKey;
}

/** Creation fields every agent-created schedule shares, including the tool call it came from. */
function agentScheduleInput(
  request: Parameters<ExecuteRuntimeBuiltinTool>[0],
  input: Readonly<Record<string, unknown>>,
) {
  const agentDeploymentId = requireAgentDeploymentId(request, "Scheduling");
  return {
    agentDeploymentId,
    createdBy: { id: agentDeploymentId, type: "agent" as const },
    createdFrom: {
      runId: request.runId,
      threadId: request.threadId,
      toolCallId: request.decision.toolCallId,
      toolName: request.toolName,
    },
    environmentId: request.environmentId,
    idempotencyKey: scheduleCreationIdempotencyKey(request),
    name: requiredString(input, "name", 120),
    organizationId: request.organizationId,
    projectId: request.projectId,
    prompt: requiredString(input, "prompt"),
    ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
  };
}

export function createRuntimeScheduleBuiltinExecutors(
  options: RuntimeScheduleToolOptions,
): Readonly<
  Record<
    | "agent.schedule.archive"
    | "agent.schedule.create"
    | "agent.schedule.list"
    | "agent.schedule.remind",
    ExecuteRuntimeBuiltinTool
  >
> {
  const automationDependencies = dependencies(options);
  // Schedules fire future production runs of a deployment, so preview and evaluation runs are
  // refused before any read, claim, or schedule write; listing stays available.
  return {
    "agent.schedule.remind": deploymentOwnedBuiltin(async (request) => {
      const input = toolInput(request.input ?? {});
      const delayMinutes = optionalInteger(input, "delayMinutes", {
        maximum: 43_200,
        minimum: 1,
      });
      if (delayMinutes === undefined) throw new TypeError("delayMinutes is required.");
      const requestedAt = decodeTime(request.decision.toolCallId);
      const expression = `at(${new Date(requestedAt + delayMinutes * 60_000)
        .toISOString()
        .slice(0, 19)})`;
      const record = await automationResult(request.toolName, () =>
        createSchedule(
          {
            ...agentScheduleInput(request, input),
            expression,
            threadId: request.threadId,
            timezone: "UTC",
          },
          automationDependencies,
        ),
      );
      if (record.data.status === "archived") {
        throw new TypeError("Reminder deadline elapsed before provisioning completed.");
      }
      return jsonToolResult({
        fileName: `schedule-${record.data.id}.json`,
        label: "Created one-shot agent reminder",
        summary: `Created one-shot reminder ${record.data.name} (${record.data.id}).`,
        value: publicSchedule(record),
      });
    }),
    "agent.schedule.create": deploymentOwnedBuiltin(async (request) => {
      const input = toolInput(request.input ?? {});
      const record = await automationResult(request.toolName, () =>
        createSchedule(
          {
            ...agentScheduleInput(request, input),
            expression: scheduleExpression(input),
            ...(optionalString(input, "timezone", 128)
              ? { timezone: optionalString(input, "timezone", 128)! }
              : {}),
          },
          automationDependencies,
        ),
      );
      return jsonToolResult({
        fileName: `schedule-${record.data.id}.json`,
        label: "Created agent schedule",
        summary: `Created schedule ${record.data.name} (${record.data.id}).`,
        value: publicSchedule(record),
      });
    }),
    "agent.schedule.list": async (request) => {
      const page = await listSchedules(options.database, request, toolInput(request.input ?? {}));
      return jsonToolResult({
        fileName: "agent-schedules.json",
        label: "Agent schedules",
        summary: `Found ${page.schedules.length} schedule(s) for the current agent${page.nextCursor ? "; more are available" : ""}.`,
        value: page,
      });
    },
    "agent.schedule.archive": deploymentOwnedBuiltin(async (request) => {
      const input = toolInput(request.input ?? {});
      const scheduleId = ulid(input.scheduledJobId, "scheduledJobId");
      const current = await automationResult(request.toolName, () =>
        getSchedule(
          {
            environmentId: request.environmentId,
            organizationId: request.organizationId,
            projectId: request.projectId,
            scheduleId,
            ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
          },
          automationDependencies,
        ),
      );
      if (
        current.data.agentDeploymentId !== request.agentDeploymentId ||
        current.data.workspaceId !== request.workspaceId
      ) {
        throw new TypeError("scheduledJobId does not belong to the current agent workspace.");
      }
      const record = await automationResult(request.toolName, () =>
        archiveSchedule(
          {
            environmentId: request.environmentId,
            organizationId: request.organizationId,
            projectId: request.projectId,
            scheduleId,
            ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
          },
          automationDependencies,
        ),
      );
      return jsonToolResult({
        fileName: `schedule-${record.data.id}.json`,
        label: "Archived agent schedule",
        summary: `Archived schedule ${record.data.name} (${record.data.id}).`,
        value: publicSchedule(record),
      });
    }),
  };
}
