import { createConversationService } from "@deployments-ai/conversations";
import { ConversationError } from "@deployments-ai/conversations";
import { agentManifestAllowsTrigger } from "@deployments-ai/agent-manifest";
import {
  RuntimeToolExecutionKnownFailureError,
  type RuntimeToolDecision,
  type RuntimeToolDefinition,
} from "@deployments-ai/agent-runtime";
import {
  key,
  makeOrganizationHoldReader,
  makeWorkflowApprovalPersistence,
  makeWorkflowExecutionPersistence,
  type DynamoDatabaseService,
  type PlatformRecord,
  Ulid,
  workflowStepCorrelation,
  workflowRuntimePersistence,
} from "@deployments-ai/db";
import { admitConsistently } from "@deployments-ai/organization-admission";
import {
  createAgentRunWorkerDependencies,
  ToolOutsideDataBoundaryError,
  type AgentRunWorkerDependencies,
} from "@deployments-ai/worker";
import Ajv, { type ValidateFunction } from "ajv";
import { Schema } from "effect";
import { createWorkflowApprovalExpirationScheduler } from "./approval-timeout.ts";
import { executionContext } from "./record-builders.ts";
import type {
  WorkflowDispatchDependencies,
  WorkflowStepDispatchContext,
  WorkflowStepDispatchResult,
} from "./types.ts";

async function get(
  database: DynamoDatabaseService,
  table: "control" | "execution",
  recordKey: { readonly pk: string; readonly sk: string },
) {
  return await workflowRuntimePersistence.read(database, table, recordKey, true);
}

function expected<T extends PlatformRecord["itemType"]>(
  value: PlatformRecord | undefined,
  itemType: T,
  label: string,
) {
  if (!value || value.itemType !== itemType) throw new Error(`${label} was not found.`);
  return value as Extract<PlatformRecord, { readonly itemType: T }>;
}

function failed(code: string, message: string): WorkflowStepDispatchResult {
  return { error: { code, message }, state: "failed" };
}

function inputSummary(input: Readonly<Record<string, unknown>>) {
  const encoded = JSON.stringify(input);
  return encoded.length <= 1_000 ? encoded : `${encoded.slice(0, 997)}...`;
}

const workflowToolSchemaValidator = new Ajv({ allErrors: true, strict: false });
const workflowToolInputValidators = new WeakMap<object, ValidateFunction>();

export function workflowToolInputMatches(
  definition: RuntimeToolDefinition,
  input: Readonly<Record<string, unknown>>,
) {
  const schema = definition.inputSchema;
  if (!schema || schema.type !== "object") {
    throw new TypeError(`Workflow tool ${definition.toolName} requires an object input schema.`);
  }
  let validate = workflowToolInputValidators.get(schema);
  if (!validate) {
    try {
      validate = workflowToolSchemaValidator.compile(schema);
    } catch (cause) {
      throw new TypeError(`Workflow tool ${definition.toolName} has an invalid input schema.`, {
        cause,
      });
    }
    workflowToolInputValidators.set(schema, validate);
  }
  return validate(input);
}

export function workflowToolCapabilityFailure(
  capability: {
    readonly authorization?: "none" | "workspace" | undefined;
    readonly requiredScopes: readonly string[];
  },
  definition: Pick<RuntimeToolDefinition, "requiredScopes">,
  workspaceId: string | undefined,
  hasWorkspaceAuthorization: boolean,
) {
  const canonical = (values: readonly string[]) =>
    [...new Set(values.map((value) => value.trim()).filter(Boolean))].toSorted();
  if (
    JSON.stringify(canonical(capability.requiredScopes)) !==
    JSON.stringify(canonical(definition.requiredScopes))
  ) {
    return failed(
      "tool_scope_mismatch",
      "Workflow tool capability scopes do not match the registered tool definition.",
    );
  }
  if (capability.authorization === "workspace" && (!workspaceId || !hasWorkspaceAuthorization)) {
    return failed(
      "tool_workspace_authorization_required",
      "Workflow tool requires a bound workspace authorization.",
    );
  }
  return undefined;
}

export function applyWorkflowToolApproval(
  decision: RuntimeToolDecision,
  approvalStepId: string | undefined,
  stepOutputs: Readonly<Record<string, unknown>>,
  approvalEvidenceByStep: Readonly<Record<string, unknown>> = {},
): RuntimeToolDecision {
  // A workflow approval step is decided before the step's input exists, so its approver never saw
  // the destinations a data boundary asks a person to approve.
  if (decision.action !== "require-approval" || decision.destinations || !approvalStepId) {
    return decision;
  }
  const output = stepOutputs[approvalStepId];
  if (
    !output ||
    typeof output !== "object" ||
    Array.isArray(output) ||
    (output as Readonly<Record<string, unknown>>).outcome !== "approved" ||
    !workflowApprovalEvidenceId(decision, approvalStepId, stepOutputs, approvalEvidenceByStep)
  ) {
    return decision;
  }
  return {
    action: "allow",
    ...(decision.executionBinding ? { executionBinding: decision.executionBinding } : {}),
    reason: decision.reason,
    toolCallId: decision.toolCallId,
  };
}

export function workflowApprovalEvidenceId(
  decision: RuntimeToolDecision,
  approvalStepId: string | undefined,
  stepOutputs: Readonly<Record<string, unknown>>,
  approvalEvidenceByStep: Readonly<Record<string, unknown>> = {},
): Ulid | undefined {
  if (decision.action !== "require-approval" || !approvalStepId) return undefined;
  const output = stepOutputs[approvalStepId];
  if (
    !output ||
    typeof output !== "object" ||
    Array.isArray(output) ||
    (output as Readonly<Record<string, unknown>>).outcome !== "approved"
  ) {
    return undefined;
  }
  try {
    return Schema.decodeUnknownSync(Ulid)(approvalEvidenceByStep[approvalStepId]);
  } catch {
    return undefined;
  }
}

export async function createWorkflowRuntimeDependencies(
  env: NodeJS.ProcessEnv = process.env,
  agentWorker?: Pick<
    AgentRunWorkerDependencies,
    "database" | "enqueueRun" | "generateId" | "runtime"
  >,
): Promise<WorkflowDispatchDependencies> {
  const { database, enqueueRun, generateId, runtime } =
    agentWorker ?? (await createAgentRunWorkerDependencies({ env }));
  if (!enqueueRun) throw new Error("Agent run queue enqueue is unavailable.");
  const persistence = makeWorkflowExecutionPersistence({
    database,
    generateId,
  });
  const approvals = makeWorkflowApprovalPersistence({ database, generateId });
  const runtimePersistence = { ...persistence, getApproval: approvals.get };
  const conversations = createConversationService({
    database,
    enqueueRun,
    generateId,
  });
  const scheduleApprovalExpiration = createWorkflowApprovalExpirationScheduler({
    env,
  });

  const loadRelease: WorkflowDispatchDependencies["loadRelease"] = async (execution) => {
    const release = expected(
      await get(database, "control", {
        pk: key("ORG", execution.data.organizationId, "ENV", execution.data.environmentId),
        sk: key("WORKFLOW-RELEASE", execution.data.workflowReleaseId),
      }),
      "workflow-release",
      "Workflow release",
    );
    return {
      contentHash: release.data.contentHash,
      definition: release.data.definition as never,
      id: release.data.id,
    };
  };

  const recoverCorrelation: NonNullable<
    WorkflowDispatchDependencies["recoverCorrelation"]
  > = async (input) => {
    if (input.externalKind !== "child-run") return undefined;
    if (typeof input.payload.threadId !== "string") return undefined;
    let threadId;
    try {
      threadId = Schema.decodeUnknownSync(Ulid)(input.payload.threadId);
    } catch {
      return undefined;
    }
    const partition = key("ORG", input.organizationId, "THREAD", threadId);
    const lookup = await get(database, "execution", {
      pk: partition,
      sk: key("RUN-LOOKUP", input.externalId),
    });
    if (!lookup || lookup.itemType !== "run-lookup") return undefined;
    const run = await get(database, "execution", {
      pk: partition,
      sk: key("RUN", lookup.data.idempotencyKey),
    });
    if (!run || run.itemType !== "run") return undefined;
    if (
      run.data.id !== input.externalId ||
      run.data.threadId !== threadId ||
      run.data.organizationId !== input.organizationId ||
      run.data.projectId !== input.projectId ||
      run.data.environmentId !== input.environmentId ||
      !run.data.userMessageId ||
      run.data.userMessageSequence === undefined
    ) {
      return undefined;
    }
    const message = await get(database, "execution", {
      pk: partition,
      sk: key(
        "MESSAGE",
        String(run.data.userMessageSequence).padStart(16, "0"),
        run.data.userMessageId,
      ),
    });
    if (!message || message.itemType !== "message") return undefined;
    const metadata = message.data.metadata;
    if (!metadata || message.data.runId !== run.data.id) return undefined;
    if (
      typeof metadata.workflowExecutionId !== "string" ||
      typeof metadata.workflowStepAttemptId !== "string"
    ) {
      return undefined;
    }
    let workflowExecutionId;
    let stepAttemptId;
    try {
      workflowExecutionId = Schema.decodeUnknownSync(Ulid)(metadata.workflowExecutionId);
      stepAttemptId = Schema.decodeUnknownSync(Ulid)(metadata.workflowStepAttemptId);
    } catch {
      return undefined;
    }
    const execution = await persistence.get(input.organizationId, workflowExecutionId);
    const attempt = await persistence.getStepAttempt(
      input.organizationId,
      workflowExecutionId,
      stepAttemptId,
    );
    if (
      execution.data.projectId !== input.projectId ||
      execution.data.environmentId !== input.environmentId ||
      execution.data.activeStepAttemptId !== stepAttemptId ||
      attempt.data.stepType !== "agent" ||
      metadata.workflowStepId !== attempt.data.stepId
    ) {
      return undefined;
    }
    return workflowStepCorrelation({
      createdAt: run.data.createdAt,
      environmentId: input.environmentId,
      externalId: input.externalId,
      externalKind: "child-run",
      organizationId: input.organizationId,
      projectId: input.projectId,
      stepAttemptId,
      workflowExecutionId,
    });
  };

  const dispatchAgent = async (
    context: WorkflowStepDispatchContext & {
      readonly action: Extract<WorkflowStepDispatchContext["action"], { kind: "dispatch-agent" }>;
    },
  ): Promise<WorkflowStepDispatchResult> => {
    const deployment = expected(
      await get(database, "control", {
        pk: key(
          "ORG",
          context.execution.data.organizationId,
          "ENV",
          context.execution.data.environmentId,
        ),
        sk: key("AGENT-DEPLOYMENT", context.action.agentDeploymentId),
      }),
      "agent-deployment",
      "Workflow agent deployment",
    );
    if (deployment.data.currentState !== "ready" || deployment.data.desiredState !== "running") {
      return failed("agent_deployment_unavailable", "Workflow agent deployment is not running.");
    }
    const actor = context.execution.data.initiatedBy;
    let result;
    try {
      result = await conversations.submitTurn({
        agentDeploymentId: deployment.data.id,
        channel: "workflow",
        content: JSON.stringify(context.action.input),
        environmentId: context.execution.data.environmentId,
        idempotencyKey: context.idempotencyKey,
        messageMetadata: {
          workflowExecutionId: context.execution.data.id,
          workflowStepAttemptId: context.stepAttempt.data.id,
          workflowStepId: context.stepAttempt.data.stepId,
        },
        organizationId: context.execution.data.organizationId,
        projectId: context.execution.data.projectId,
        trigger: "workflow",
        actor:
          actor.type === "principal" || actor.type === "service-account" || actor.type === "system"
            ? { ...(actor.id ? { id: actor.id } : {}), type: actor.type }
            : { type: "system" },
        ...(context.execution.data.workspaceId
          ? { workspaceId: context.execution.data.workspaceId }
          : {}),
        title: `Workflow: ${context.stepAttempt.data.stepId}`,
      });
    } catch (cause) {
      if (
        cause instanceof ConversationError &&
        !new Set(["idempotency_in_progress", "stream_unavailable", "write_failed"]).has(cause.code)
      ) {
        return failed(cause.code, cause.message);
      }
      throw cause;
    }
    return {
      referenceId: result.run.data.id,
      referenceKind: "child-run",
      state: "waiting",
    };
  };

  const dispatchTool = async (
    context: WorkflowStepDispatchContext & {
      readonly action: Extract<WorkflowStepDispatchContext["action"], { kind: "dispatch-tool" }>;
    },
  ): Promise<WorkflowStepDispatchResult> => {
    if (!runtime.resolveToolDefinition || !runtime.authorizeToolCall || !runtime.executeToolCall) {
      throw new Error("Agent runtime tool services are unavailable.");
    }
    const { decision: standing } = await admitConsistently({
      activity: "background.process",
      organizationId: context.execution.data.organizationId,
      standing: makeOrganizationHoldReader(database),
    });
    if (standing.kind === "suspended") {
      return failed("organization_suspended", "The organization is suspended.");
    }
    const deployment = expected(
      await get(database, "control", {
        pk: key(
          "ORG",
          context.execution.data.organizationId,
          "ENV",
          context.execution.data.environmentId,
        ),
        sk: key("AGENT-DEPLOYMENT", context.action.agentDeploymentId),
      }),
      "agent-deployment",
      "Workflow tool deployment",
    );
    if (deployment.data.currentState !== "ready" || deployment.data.desiredState !== "running") {
      return failed("tool_deployment_unavailable", "Workflow tool deployment is not running.");
    }
    const release = expected(
      await get(database, "control", {
        pk: key(
          "ORG",
          context.execution.data.organizationId,
          "ENV",
          context.execution.data.environmentId,
        ),
        sk: key("AGENT-RELEASE", deployment.data.agentReleaseId),
      }),
      "agent-release",
      "Workflow tool agent release",
    );
    const capability = (release.data.manifest.spec.capabilities?.tools ?? []).find(
      (candidate) => candidate.name === context.action.toolName,
    );
    if (!capability) {
      return failed(
        "tool_not_declared",
        `Workflow tool ${context.action.toolName} is not declared by the pinned agent release.`,
      );
    }
    if (!agentManifestAllowsTrigger(release.data.manifest, "workflow")) {
      return failed(
        "trigger_not_allowed",
        "The pinned agent release does not allow workflow-triggered tool execution.",
      );
    }
    const identity = {
      agentDefinitionId: deployment.data.agentDefinitionId,
      agentDeploymentId: deployment.data.id,
      agentReleaseId: deployment.data.agentReleaseId,
      environmentId: context.execution.data.environmentId,
      organizationId: context.execution.data.organizationId,
      projectId: context.execution.data.projectId,
      runId: context.execution.data.id,
      threadId: context.stepAttempt.data.id,
      ...(context.execution.data.workspaceId
        ? { workspaceId: context.execution.data.workspaceId }
        : {}),
    };
    let definition: RuntimeToolDefinition | undefined;
    try {
      definition = await runtime.resolveToolDefinition(context.action.toolName, identity);
    } catch (cause) {
      if (cause instanceof ToolOutsideDataBoundaryError) return failed(cause.code, cause.message);
      throw cause;
    }
    if (!definition) return failed("tool_unavailable", "Workflow tool is not registered.");
    const capabilityFailure = workflowToolCapabilityFailure(
      capability,
      definition,
      context.execution.data.workspaceId,
      Boolean(deployment.data.runtimeConfig?.toolAuthorizations?.[context.action.toolName]),
    );
    if (capabilityFailure) return capabilityFailure;
    let inputMatches: boolean;
    try {
      inputMatches = workflowToolInputMatches(definition, context.action.input);
    } catch {
      return failed("invalid_tool_schema", "Workflow tool input schema is invalid.");
    }
    if (!inputMatches) {
      return failed("invalid_tool_input", "Workflow tool input does not match its schema.");
    }
    const request = {
      ...identity,
      effect: definition.effect,
      idempotencyKey: context.idempotencyKey,
      input: context.action.input,
      inputSummary: inputSummary(context.action.input),
      requiredScopes: definition.requiredScopes,
      toolName: context.action.toolName,
    };
    const policyDecision = await runtime.authorizeToolCall(request);
    const stepOutputs = executionContext(context.execution).stepOutputs;
    const approvalEvidenceValue = context.execution.data.context.approvalEvidenceByStep;
    const approvalEvidenceByStep =
      approvalEvidenceValue &&
      typeof approvalEvidenceValue === "object" &&
      !Array.isArray(approvalEvidenceValue)
        ? (approvalEvidenceValue as Readonly<Record<string, unknown>>)
        : {};
    const decision = applyWorkflowToolApproval(
      policyDecision,
      context.action.approvalStepId,
      stepOutputs,
      approvalEvidenceByStep,
    );
    if (decision.action === "deny") {
      return failed("tool_denied", decision.reason);
    }
    if (decision.action === "require-approval" && decision.destinations) {
      return failed(
        "tool_outside_data_boundary",
        `${decision.reason} A workflow approval step cannot approve them, because it is decided before the step's input exists.`,
      );
    }
    if (decision.action === "require-approval") {
      return failed(
        "tool_approval_required",
        "Tool policy approval must be modeled as an explicit workflow approval step.",
      );
    }
    let result;
    try {
      const approvedByWorkflow =
        policyDecision.action === "require-approval" && decision.action === "allow";
      const approvalId = workflowApprovalEvidenceId(
        policyDecision,
        context.action.approvalStepId,
        stepOutputs,
        approvalEvidenceByStep,
      );
      if (approvedByWorkflow !== Boolean(approvalId)) {
        throw new RuntimeToolExecutionKnownFailureError(
          context.action.toolName,
          new Error("Workflow tool approval evidence is missing its persisted approval ID."),
        );
      }
      result = await runtime.executeToolCall({
        ...request,
        ...(approvalId ? { approvalId } : {}),
        decision,
        executionKind: "workflow",
        policyAction: approvedByWorkflow ? "require-approval" : "allow",
      });
    } catch (cause) {
      if (cause instanceof RuntimeToolExecutionKnownFailureError) {
        return failed("tool_execution_failed", "Workflow tool execution failed permanently.");
      }
      throw cause;
    }
    if (result.status === "running") {
      return failed(
        "asynchronous_tool_unsupported",
        "Asynchronous tools are not supported by deterministic workflow tool steps.",
      );
    }
    return {
      output: {
        ...(result.externalOperationId ? { externalOperationId: result.externalOperationId } : {}),
        ...(result.outputSummary ? { outputSummary: result.outputSummary } : {}),
        status: result.status,
      },
      state: "succeeded",
    };
  };

  const dispatchStep: WorkflowDispatchDependencies["dispatchStep"] = async (context) => {
    switch (context.action.kind) {
      case "dispatch-agent":
        return dispatchAgent(context as Parameters<typeof dispatchAgent>[0]);
      case "dispatch-tool":
        return dispatchTool(context as Parameters<typeof dispatchTool>[0]);
      case "request-approval": {
        const expiresAt = context.action.timeoutSeconds
          ? new Date(Date.now() + context.action.timeoutSeconds * 1_000).toISOString()
          : undefined;
        const approval = await approvals.create({
          environmentId: context.execution.data.environmentId,
          ...(expiresAt ? { expiresAt } : {}),
          id: context.stepAttempt.data.id,
          organizationId: context.execution.data.organizationId,
          projectId: context.execution.data.projectId,
          prompt: context.action.prompt,
          requestedBy: context.execution.data.initiatedBy,
          stepAttemptId: context.stepAttempt.data.id,
          workflowExecutionId: context.execution.data.id,
        });
        return {
          referenceId: approval.approval.data.id,
          referenceKind: "approval",
          state: "waiting",
        };
      }
      case "send-notification":
        return {
          output: {
            channel: context.action.channel,
            emitted: true,
            target: context.action.target,
          },
          state: "succeeded",
        };
      case "emit-escalation":
        return {
          output: { emitted: true, target: context.action.target },
          state: "succeeded",
        };
    }
  };

  const scheduleOrExpireApproval: NonNullable<
    WorkflowDispatchDependencies["scheduleApprovalExpiration"]
  > = async (input) => {
    if (Date.parse(input.expiresAt) <= Date.now()) {
      await approvals.resolve({
        decision: "expired",
        organizationId: input.organizationId,
        resolvedBy: { type: "system" },
        workflowApprovalId: input.approvalId,
        workflowExecutionId: input.executionId,
      });
      return;
    }
    await scheduleApprovalExpiration(input);
  };

  return {
    dispatchStep,
    generateId,
    loadRelease,
    persistence: runtimePersistence,
    recoverCorrelation,
    scheduleApprovalExpiration: scheduleOrExpireApproval,
  };
}

let dependenciesPromise: Promise<WorkflowDispatchDependencies> | undefined;

export function cachedWorkflowRuntimeDependencies() {
  return (dependenciesPromise ??= createWorkflowRuntimeDependencies().catch((cause) => {
    dependenciesPromise = undefined;
    throw cause;
  }));
}
