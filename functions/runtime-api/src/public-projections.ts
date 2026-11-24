import { parseAutomationRunIdempotencyKey } from "@deployments-ai/automations/run-key";
import { executionBindingIsActive, type PlatformRecord } from "@deployments-ai/db";

export function publicRun(record: Extract<PlatformRecord, { readonly itemType: "run" }>) {
  const {
    claimedAt: _claimedAt,
    claimedBy: _claimedBy,
    captureMode: _captureMode,
    executionSlot: _executionSlot,
    heartbeatAt: _heartbeatAt,
    idempotencyKey,
    initiatingCaller: _initiatingCaller,
    inputArtifacts: _inputArtifacts,
    queuedAt: _queuedAt,
    responseFormat: _responseFormat,
    redactionPolicyVersion: _redactionPolicyVersion,
    responsePublication: _responsePublication,
    runContext: _runContext,
    schemaVersion: _schemaVersion,
    sandboxPoolId: _sandboxPoolId,
    toolContinuation: _toolContinuation,
    userMessageId: _userMessageId,
    userMessageSequence: _userMessageSequence,
    ...data
  } = record.data;
  // A replay copies its source's trigger but takes the caller's key, so only an original run's key
  // names the automation fire that submitted it.
  const automation =
    data.replayedFromRunId === undefined
      ? parseAutomationRunIdempotencyKey(idempotencyKey)
      : undefined;
  return {
    ...data,
    ...(automation?.kind === data.trigger ? { automation } : {}),
    checkpointCount: data.checkpointCount ?? 0,
    executionPurpose: data.executionPurpose ?? "customer",
    object: record.itemType,
  };
}

export function publicThread(record: Extract<PlatformRecord, { readonly itemType: "thread" }>) {
  const { endUserKey: _endUserKey, ...data } = record.data;
  return {
    ...data,
    executionPurpose: data.executionPurpose ?? "customer",
    object: record.itemType,
  };
}

/** Projects a preview execution binding; status reflects logical expiry, not only explicit expiry. */
export function publicPreview(
  record: Extract<PlatformRecord, { readonly itemType: "execution-binding" }>,
  now: Date,
) {
  const binding = record.data;
  return {
    agentName: binding.manifest.metadata.name,
    contentHash: binding.contentHash,
    createdAt: binding.createdAt,
    createdBy: binding.createdBy,
    environmentId: binding.environmentId,
    ...(binding.expiredAt ? { expiredAt: binding.expiredAt } : {}),
    expiresAt: binding.expiresAt,
    id: binding.id,
    object: "preview" as const,
    organizationId: binding.organizationId,
    projectId: binding.projectId,
    ...(binding.runtimeConfigSourceAgentDeploymentId
      ? { runtimeConfigFromAgentDeploymentId: binding.runtimeConfigSourceAgentDeploymentId }
      : {}),
    status: executionBindingIsActive(record, now) ? ("active" as const) : ("expired" as const),
    updatedAt: binding.updatedAt,
    version: binding.version,
  };
}

export function publicMessagePublication(
  record: Extract<PlatformRecord, { readonly itemType: "message-publication" }>,
) {
  const {
    actor: _actor,
    commandHash: _commandHash,
    deliveredContentHash: _deliveredContentHash,
    safeContentHash: _safeContentHash,
    ...data
  } = record.data;
  return { ...data, object: record.itemType };
}

export function publicToolCall(
  record: Extract<PlatformRecord, { readonly itemType: "tool-call" }>,
) {
  const {
    authorizationFingerprint: _authorizationFingerprint,
    connectionId: _connectionId,
    destinationsHash: _destinationsHash,
    externalAccountId: _externalAccountId,
    idempotencyKey: _idempotencyKey,
    input: _input,
    inputHash: _inputHash,
    mutationEnvelope: _mutationEnvelope,
    observability: _observability,
    output: _output,
    ...data
  } = record.data;
  // Client-executed tools are run by the caller, which needs the input and its submitted output.
  const clientData =
    record.data.executionType === "client"
      ? {
          input: record.data.input ?? {},
          ...(record.data.output ? { output: record.data.output } : {}),
        }
      : {};
  return { ...data, ...clientData, object: record.itemType };
}

export function publicCallbackDispatchEvidence(
  record: Extract<PlatformRecord, { readonly itemType: "callback-dispatch-evidence" }>,
) {
  const {
    authorizationFingerprint: _authorizationFingerprint,
    connectionId: _connectionId,
    externalAccountId: _externalAccountId,
    input: _input,
    inputSummary: _inputSummary,
    origin: _origin,
    toolAdapterId: _toolAdapterId,
    toolPlanFingerprint: _toolPlanFingerprint,
    ...data
  } = record.data;
  return { ...data, object: record.itemType };
}

export function publicApproval(record: Extract<PlatformRecord, { readonly itemType: "approval" }>) {
  const { observability: _observability, ...data } = record.data;
  return {
    ...data,
    executionPurpose: data.executionPurpose ?? "customer",
    object: record.itemType,
  };
}

export function publicSchedule(record: Extract<PlatformRecord, { readonly itemType: "schedule" }>) {
  const {
    creationHash: _creationHash,
    timerActivationPending: _pending,
    timerActivationValidated: _validated,
    timerVersion: _timerVersion,
    ...schedule
  } = record.data.schedule;
  return { ...record.data, schedule, object: record.itemType };
}

export function publicHeartbeat(
  record: Extract<PlatformRecord, { readonly itemType: "heartbeat" }>,
) {
  const {
    creationHash: _creationHash,
    timerActivationPending: _pending,
    timerActivationValidated: _validated,
    timerVersion: _timerVersion,
    ...schedule
  } = record.data.schedule;
  return { ...record.data, schedule, object: record.itemType };
}
