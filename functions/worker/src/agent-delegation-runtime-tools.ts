import {
  RuntimeToolPreparationRetryableError,
  requireAgentDeploymentId,
} from "@deployments-ai/agent-runtime";
import {
  ConversationError,
  createConversationService,
  type ConversationQueueEnqueue,
} from "@deployments-ai/conversations";
import {
  MAX_DYNAMODB_ITEM_BYTES,
  dynamoItemByteSize,
  key,
  type DynamoDatabaseService,
  type PlatformRecord,
  type Ulid,
  workerPersistence,
} from "@deployments-ai/db";
import type { ThreadStreamEvent } from "@deployments-ai/streaming";
import type { ExecuteRuntimeBuiltinTool } from "./runtime-tools.ts";
import {
  builtinMutationClaimIdempotencyKey,
  providerMutationRequestIdempotencyKey,
} from "./runtime-idempotency.ts";
import {
  jsonToolResult,
  optionalInteger,
  optionalString,
  queryRecordPages,
  requiredString,
  toolInput,
  ulid,
} from "./builtin-tool-support.ts";
import {
  assertDeclaredDelegationAllowed,
  loadDeclaredDelegation,
  retryableDatabaseRead,
  selectDeclaredTarget,
} from "./agent-delegation-targets.ts";
import { deploymentOwnedBuiltin } from "./execution-tool-policy.ts";

type Deployment = Extract<PlatformRecord, { readonly itemType: "agent-deployment" }>;
type RunLookup = Extract<PlatformRecord, { readonly itemType: "run-lookup" }>;
const MAX_DELEGATION_RECORD_PAYLOAD_BYTES = MAX_DYNAMODB_ITEM_BYTES - 64 * 1_024;

export interface RuntimeAgentDelegationOptions {
  readonly appendThreadEvent?: (event: ThreadStreamEvent) => Promise<void>;
  readonly database: DynamoDatabaseService;
  readonly enqueueRun: ConversationQueueEnqueue;
  readonly generateId: () => Promise<Ulid>;
}

async function controlRecord(
  database: DynamoDatabaseService,
  request: Parameters<ExecuteRuntimeBuiltinTool>[0],
  itemType: "agent-definition" | "agent-deployment",
  id: Ulid,
) {
  return await retryableDatabaseRead(request, () =>
    workerPersistence.read(
      database,
      "control",
      {
        pk: key("ORG", request.organizationId, "ENV", request.environmentId),
        sk: key(itemType.toUpperCase(), id),
      },
      true,
    ),
  );
}

async function deployments(
  database: DynamoDatabaseService,
  request: Parameters<ExecuteRuntimeBuiltinTool>[0],
) {
  const items = await retryableDatabaseRead(request, () =>
    queryRecordPages({
      database,
      input: {
        ExpressionAttributeNames: { "#pk": "gsi2pk", "#sk": "gsi2sk" },
        ExpressionAttributeValues: {
          ":pk": key("ENV", request.environmentId),
          ":sk": "AGENT-DEPLOYMENT#",
        },
        IndexName: "gsi2",
        KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :sk)",
        Limit: 250,
        ScanIndexForward: false,
      },
      ...(request.signal ? { signal: request.signal } : {}),
      table: "control",
    }),
  );
  return items.filter(
    (record): record is Deployment =>
      record.itemType === "agent-deployment" &&
      record.data.organizationId === request.organizationId &&
      record.data.projectId === request.projectId,
  );
}

async function targetDeployment(
  database: DynamoDatabaseService,
  request: Parameters<ExecuteRuntimeBuiltinTool>[0],
  targetAgentId: Ulid,
) {
  const direct = await controlRecord(database, request, "agent-deployment", targetAgentId);
  const definitionId =
    direct?.itemType === "agent-deployment" ? direct.data.agentDefinitionId : targetAgentId;
  const definition = await controlRecord(database, request, "agent-definition", definitionId);
  const definitionInScope =
    definition?.itemType === "agent-definition" &&
    definition.data.organizationId === request.organizationId &&
    definition.data.projectId === request.projectId &&
    definition.data.environmentId === request.environmentId &&
    definition.data.status === "active" &&
    definition.data.workspaceId === request.workspaceId;
  if (!definitionInScope) throw new TypeError("Target agent was not found in the current scope.");
  const candidates =
    direct?.itemType === "agent-deployment" ? [direct] : await deployments(database, request);
  const ready = candidates.find(
    (deployment) =>
      deployment.data.organizationId === request.organizationId &&
      deployment.data.projectId === request.projectId &&
      deployment.data.environmentId === request.environmentId &&
      deployment.data.agentDefinitionId === definition.data.id &&
      deployment.data.currentState === "ready" &&
      deployment.data.desiredState === "running",
  );
  if (!ready) throw new TypeError("Target agent has no ready deployment in the current scope.");
  return ready;
}

export async function loadDelegationParentRun(
  database: DynamoDatabaseService,
  request: Parameters<ExecuteRuntimeBuiltinTool>[0],
) {
  const partition = key("ORG", request.organizationId, "THREAD", request.threadId);
  const lookup = await retryableDatabaseRead(request, () =>
    workerPersistence.read(
      database,
      "execution",
      { pk: partition, sk: key("RUN-LOOKUP", request.runId) },
      true,
    ),
  );
  if (
    lookup?.itemType !== "run-lookup" ||
    lookup.data.runId !== request.runId ||
    lookup.data.organizationId !== request.organizationId ||
    lookup.data.projectId !== request.projectId ||
    lookup.data.environmentId !== request.environmentId ||
    lookup.data.threadId !== request.threadId
  ) {
    throw new TypeError("Parent run could not be loaded for delegation.");
  }
  const typedLookup: RunLookup = lookup;
  const run = await retryableDatabaseRead(request, () =>
    workerPersistence.read(
      database,
      "execution",
      { pk: partition, sk: key("RUN", typedLookup.data.idempotencyKey) },
      true,
    ),
  );
  if (
    run?.itemType !== "run" ||
    run.data.id !== request.runId ||
    run.data.idempotencyKey !== typedLookup.data.idempotencyKey ||
    run.data.organizationId !== request.organizationId ||
    run.data.projectId !== request.projectId ||
    run.data.environmentId !== request.environmentId ||
    run.data.threadId !== request.threadId
  ) {
    throw new TypeError("Parent run could not be loaded for delegation.");
  }
  return run;
}

function optionalObject(input: Readonly<Record<string, unknown>>, name: string) {
  const value = input[name];
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`${name} must be an object.`);
  return value as Readonly<Record<string, unknown>>;
}

function constraints(input: Readonly<Record<string, unknown>>) {
  if (input.constraints === undefined) return [];
  if (
    !Array.isArray(input.constraints) ||
    input.constraints.length > 50 ||
    input.constraints.some((value) => typeof value !== "string")
  ) {
    throw new TypeError("constraints must contain at most 50 strings.");
  }
  return input.constraints.map((value) => String(value).trim()).filter(Boolean);
}

function assertDelegationPayloadFits(
  prompt: string,
  messageMetadata: Readonly<Record<string, unknown>>,
  edgeMetadata: Readonly<Record<string, unknown>> | undefined,
) {
  if (
    dynamoItemByteSize({ body: prompt, metadata: messageMetadata }) >
      MAX_DELEGATION_RECORD_PAYLOAD_BYTES ||
    (edgeMetadata !== undefined &&
      dynamoItemByteSize({ metadata: edgeMetadata }) > MAX_DELEGATION_RECORD_PAYLOAD_BYTES)
  ) {
    throw new TypeError("Delegation content and metadata exceed the durable record size limit.");
  }
}

export function classifyDelegationFailure(toolName: string, cause: unknown) {
  if (!(cause instanceof ConversationError)) {
    return cause instanceof TypeError
      ? cause
      : new RuntimeToolPreparationRetryableError(toolName, cause);
  }
  if (cause.code === "stream_unavailable" || cause.code === "write_failed") {
    return new RuntimeToolPreparationRetryableError(toolName, cause);
  }
  return new TypeError(cause.message, { cause });
}

export function delegationSubmissionIdempotencyKey(
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
    ? providerMutationRequestIdempotencyKey(
        request.runId,
        `${request.toolName}\u0000${request.idempotencyKey}`,
      )
    : claimKey;
}

export function createRuntimeAgentDelegationBuiltinExecutors(
  options: RuntimeAgentDelegationOptions,
): Readonly<Record<"agent.delegate", ExecuteRuntimeBuiltinTool>> {
  const service = createConversationService({
    ...(options.appendThreadEvent ? { appendThreadEvent: options.appendThreadEvent } : {}),
    database: options.database,
    enqueueRun: options.enqueueRun,
    generateId: options.generateId,
  });
  return {
    // Preview and evaluation runs are refused before any read, claim, or submission.
    "agent.delegate": deploymentOwnedBuiltin(async (request) => {
      const input = toolInput(request.input ?? {});
      const priority = optionalInteger(input, "priority", {
        maximum: 99_999_999,
        minimum: 0,
      });
      const requestedConstraints = constraints(input);
      const requestedOutcome = optionalString(input, "requestedOutcome", 4_000);
      const prompt = [
        requiredString(input, "prompt", 200_000),
        ...(requestedOutcome ? [`\nRequested outcome:\n${requestedOutcome}`] : []),
        ...(requestedConstraints.length > 0
          ? [`\nConstraints:\n${requestedConstraints.map((value) => `- ${value}`).join("\n")}`]
          : []),
      ].join("\n");
      const requestedEdgeKind = optionalString(input, "edgeKind", 64);
      if (
        requestedEdgeKind !== undefined &&
        !["approval_followup", "delegation", "handoff", "scheduled_child"].includes(
          requestedEdgeKind,
        )
      )
        throw new TypeError("edgeKind is invalid.");
      const edgeMetadata = optionalObject(input, "metadata");
      const messageMetadata = {
        ...edgeMetadata,
        ...optionalObject(input, "input"),
        delegatedByRunId: request.runId,
      };
      assertDelegationPayloadFits(prompt, messageMetadata, edgeMetadata);
      const declared = await loadDeclaredDelegation(options.database, request);
      const selection = declared
        ? selectDeclaredTarget(
            declared,
            requiredString(input, "targetAgentId", 256),
            requestedEdgeKind,
          )
        : undefined;
      const edgeKind = selection?.edgeKind ?? requestedEdgeKind ?? "delegation";
      const target = await targetDeployment(
        options.database,
        request,
        ulid(selection?.agentDeploymentId ?? input.targetAgentId, "targetAgentId"),
      );
      if (target.data.id === request.agentDeploymentId)
        throw new TypeError("An agent cannot delegate to its current deployment.");
      if (selection) {
        await assertDeclaredDelegationAllowed(options.database, request, selection, target);
      }
      const parent = await loadDelegationParentRun(options.database, request);
      let result: Awaited<ReturnType<typeof service.submitTurn>>;
      try {
        result = await service.submitTurn({
          actor: { type: "system" },
          agentDeploymentId: target.data.id,
          content: prompt,
          environmentId: request.environmentId,
          idempotencyKey: delegationSubmissionIdempotencyKey(request),
          ...(parent.data.initiatingCaller
            ? { initiatingCaller: parent.data.initiatingCaller }
            : {}),
          messageMetadata,
          organizationId: request.organizationId,
          ...(priority !== undefined ? { priority } : {}),
          projectId: request.projectId,
          ...(request.signal ? { signal: request.signal } : {}),
          title: optionalString(input, "title", 120) ?? "Delegated agent task",
          traceContext: {
            ...(selection?.awaitResult ? { awaitResult: true } : {}),
            edgeKind: edgeKind as
              | "approval_followup"
              | "delegation"
              | "handoff"
              | "scheduled_child",
            ...(edgeMetadata ? { metadata: edgeMetadata } : {}),
            // Delegated children are production runs of the target deployment; bound runs never
            // reach here because `deploymentOwnedToolPreflight` refuses them model-visibly.
            parentAgentDeploymentId: requireAgentDeploymentId(request, "Agent delegation"),
            parentRunId: request.runId,
            parentSpanId: parent.data.spanId,
            parentThreadId: request.threadId,
            traceId: parent.data.traceId,
          },
          trigger: "api",
          ...(request.workspaceId ? { workspaceId: request.workspaceId } : {}),
        });
      } catch (cause) {
        throw classifyDelegationFailure(request.toolName, cause);
      }
      if (selection?.awaitResult) {
        // The parent pauses until the child's terminal result resolves this tool call.
        return {
          externalOperationId: result.run.data.id,
          outputSummary: `Waiting for sub-agent ${selection.agent.key} run ${result.run.data.id}.`,
          status: "running",
        };
      }
      return jsonToolResult({
        fileName: `delegation-${result.run.data.id}.json`,
        label: "Agent delegation",
        summary: `Delegated work to agent deployment ${target.data.id}; child run ${result.run.data.id}.`,
        value: {
          childRunId: result.run.data.id,
          childThreadId: result.thread.data.id,
          created: result.created,
          targetAgentDeploymentId: target.data.id,
        },
      });
    }),
  };
}
