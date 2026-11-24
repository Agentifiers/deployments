import {
  canonicalAgentDeploymentConfigJson,
  validateAgentDeploymentConfig,
  validateAgentManifest,
  type AgentDeploymentConfigV1,
  type AgentManifestV1,
} from "@deployments-ai/agent-manifest";
import {
  DEFAULT_DEPLOYMENT_CONFIG,
  ExecutionBindingRecord,
  IdempotencyRecord,
  executionBindingIdempotencyKey,
  makeExecutionBindingPersistence,
  withCanonicalRecordKeys,
  type AdmitManifest,
  type BoundExecutionPurpose,
  type ExecutionBindingRecordValue,
  type ExecutionBindingSource,
  type ExecutionBindingToolPolicy,
  type ExecutionPurpose,
  type Ulid,
} from "@deployments-ai/db";
import { internalSemanticEventPayload, makeSemanticEventRecord } from "@deployments-ai/events";
import { Schema } from "effect";
import { createHash } from "node:crypto";
import { assertExecutionBindingManifestAdmitted } from "./execution-binding-model-admission.ts";
import {
  ConversationError,
  expected,
  queueIdempotencyKey,
  record,
  type ConversationServiceOptions,
} from "./submission.ts";

export type { BoundExecutionPurpose, ExecutionBindingToolPolicy, ExecutionPurpose };

/** Admits a binding's manifest the way publish does; composition roots inject it. */
export interface ExecutionBindingAdmission {
  readonly admitManifest: AdmitManifest;
}
export type ExecutionBinding = ExecutionBindingRecordValue;

export const DEFAULT_EXECUTION_BINDING_TTL_SECONDS = 24 * 60 * 60;
export const MIN_EXECUTION_BINDING_TTL_SECONDS = 60;
export const MAX_EXECUTION_BINDING_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface ExecutionBindingScope {
  readonly environmentId: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
}

/** The authenticated caller that owns a binding; idempotency keys are scoped to it. */
export interface ExecutionBindingCreator {
  readonly id: Ulid;
  readonly type: "principal" | "service-account";
}

export type ExecutionBindingManifestSource =
  | { readonly manifest: unknown; readonly type: "manifest" }
  | { readonly agentReleaseId: Ulid; readonly type: "release" };

export interface CreateExecutionBindingInput extends ExecutionBindingScope {
  readonly createdBy: ExecutionBindingCreator;
  readonly idempotencyKey: string;
  readonly purpose: BoundExecutionPurpose;
  /** Inline deployment configuration validated against the binding manifest. */
  readonly runtimeConfig?: AgentDeploymentConfigV1;
  /**
   * Snapshot the runtime configuration of an existing deployment at creation time. The source
   * deployment is not required to be ready or running and is never modified.
   */
  readonly runtimeConfigFromAgentDeploymentId?: Ulid;
  readonly source: ExecutionBindingManifestSource;
  readonly toolPolicy: ExecutionBindingToolPolicy;
  readonly ttlSeconds: number;
}

export interface ExecutionBindingResult {
  readonly binding: ExecutionBinding;
  readonly created: boolean;
}

export interface ExpireExecutionBindingInput extends ExecutionBindingScope {
  readonly actor: ExecutionBindingCreator;
  readonly executionBindingId: Ulid;
}

function issuesMessage(issues: readonly { readonly message: string; readonly path: string }[]) {
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n");
}

interface ResolvedManifest {
  readonly contentHash: string;
  readonly manifest: AgentManifestV1;
}

/** Applies the same manifest validation as publishing a release. */
function validInlineManifest(manifest: unknown): ResolvedManifest {
  const validation = validateAgentManifest(manifest);
  if (!validation.ok) {
    throw new ConversationError("invalid_agent_manifest", issuesMessage(validation.issues));
  }
  return { contentHash: validation.contentHash, manifest: validation.manifest };
}

function bindingCommandHash(input: CreateExecutionBindingInput, manifestContentHash?: string) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        createdBy: input.createdBy,
        environmentId: input.environmentId,
        organizationId: input.organizationId,
        projectId: input.projectId,
        purpose: input.purpose,
        runtimeConfig:
          input.runtimeConfig === undefined
            ? null
            : canonicalAgentDeploymentConfigJson(input.runtimeConfig),
        runtimeConfigFromAgentDeploymentId: input.runtimeConfigFromAgentDeploymentId ?? null,
        source:
          input.source.type === "manifest"
            ? { contentHash: manifestContentHash, type: "manifest" }
            : { agentReleaseId: input.source.agentReleaseId, type: "release" },
        toolPolicy: input.toolPolicy,
        ttlSeconds: input.ttlSeconds,
      }),
    )
    .digest("hex");
}

function assertScope(
  value: { readonly environmentId: Ulid; readonly organizationId: Ulid; readonly projectId: Ulid },
  scope: ExecutionBindingScope,
  label: string,
) {
  if (
    value.organizationId !== scope.organizationId ||
    value.projectId !== scope.projectId ||
    value.environmentId !== scope.environmentId
  ) {
    throw new ConversationError("not_found", `${label} was not found.`);
  }
}

export function createExecutionBindingService(
  options: Pick<ConversationServiceOptions, "database" | "generateId" | "now"> &
    ExecutionBindingAdmission,
) {
  const persistence = makeExecutionBindingPersistence(options.database);

  async function getExecutionBinding(
    scope: ExecutionBindingScope & { readonly executionBindingId: Ulid },
  ): Promise<ExecutionBinding> {
    const binding = await persistence.get(scope);
    if (!binding) throw new ConversationError("not_found", "Execution binding was not found.");
    assertScope(binding.data, scope, "Execution binding");
    return binding;
  }

  async function replayExecutionBinding(
    input: CreateExecutionBindingInput,
    idempotencyKey: string,
    commandHash: string,
    at: Date,
  ): Promise<ExecutionBindingResult | undefined> {
    const claim = await persistence.getIdempotency(input.organizationId, idempotencyKey);
    if (!claim || Date.parse(claim.data.expiresAt) <= at.getTime()) return undefined;
    if (claim.data.commandHash !== commandHash) {
      throw new ConversationError(
        "idempotency_conflict",
        "Idempotency key belongs to another request.",
      );
    }
    const [executionBindingId] = claim.data.resourceIds;
    if (!executionBindingId) {
      throw new ConversationError("idempotency_corrupt", "Idempotent response is incomplete.");
    }
    return {
      binding: await getExecutionBinding({ ...input, executionBindingId }),
      created: false,
    };
  }

  async function resolveSource(
    input: CreateExecutionBindingInput,
    inlineManifest: ResolvedManifest | undefined,
  ): Promise<ResolvedManifest & { readonly source: ExecutionBindingSource }> {
    if (inlineManifest) return { ...inlineManifest, source: { type: "manifest" } };
    if (input.source.type !== "release") {
      throw new ConversationError("invalid_request", "Execution binding source is invalid.");
    }
    const release = expected(
      await record(options.database, {
        environmentId: input.environmentId,
        id: input.source.agentReleaseId,
        kind: "agent-release",
        organizationId: input.organizationId,
      }),
      "agent-release",
      "Agent release",
    );
    assertScope(release.data, input, "Agent release");
    if (release.data.status !== "active") {
      throw new ConversationError("release_unavailable", "Agent release is not active.");
    }
    return {
      contentHash: release.data.contentHash,
      manifest: release.data.manifest,
      source: {
        agentDefinitionId: release.data.agentDefinitionId,
        agentReleaseId: release.data.id,
        type: "release",
      },
    };
  }

  async function resolveRuntimeConfig(
    input: CreateExecutionBindingInput,
  ): Promise<AgentDeploymentConfigV1 | undefined> {
    if (input.runtimeConfigFromAgentDeploymentId === undefined) return input.runtimeConfig;
    const deployment = expected(
      await record(options.database, {
        environmentId: input.environmentId,
        id: input.runtimeConfigFromAgentDeploymentId,
        kind: "agent-deployment",
        organizationId: input.organizationId,
      }),
      "agent-deployment",
      "Agent deployment",
    );
    assertScope(deployment.data, input, "Agent deployment");
    return deployment.data.runtimeConfig === undefined
      ? undefined
      : structuredClone(deployment.data.runtimeConfig);
  }

  async function createExecutionBinding(
    input: CreateExecutionBindingInput,
  ): Promise<ExecutionBindingResult> {
    if (
      !Number.isSafeInteger(input.ttlSeconds) ||
      input.ttlSeconds < MIN_EXECUTION_BINDING_TTL_SECONDS ||
      input.ttlSeconds > MAX_EXECUTION_BINDING_TTL_SECONDS
    ) {
      throw new ConversationError(
        "invalid_request",
        `Execution binding TTL must be an integer from ${MIN_EXECUTION_BINDING_TTL_SECONDS} to ${MAX_EXECUTION_BINDING_TTL_SECONDS} seconds.`,
      );
    }
    if (input.runtimeConfig !== undefined && input.runtimeConfigFromAgentDeploymentId) {
      throw new ConversationError(
        "invalid_request",
        "Provide either runtimeConfig or runtimeConfigFromAgentDeploymentId, not both.",
      );
    }
    const inlineManifest =
      input.source.type === "manifest" ? validInlineManifest(input.source.manifest) : undefined;
    const normalizedKey = queueIdempotencyKey(input.idempotencyKey);
    const idempotencyKey = executionBindingIdempotencyKey(
      { ...input, principalId: input.createdBy.id },
      normalizedKey,
    );
    const commandHash = bindingCommandHash(input, inlineManifest?.contentHash);
    const now = options.now?.() ?? new Date();
    const replayed = await replayExecutionBinding(input, idempotencyKey, commandHash, now);
    if (replayed) return replayed;

    const resolved = await resolveSource(input, inlineManifest);
    const runtimeConfig = await resolveRuntimeConfig(input);
    await assertExecutionBindingManifestAdmitted(
      options.admitManifest,
      {
        ...(resolved.source.type === "release"
          ? { agentDefinitionId: resolved.source.agentDefinitionId }
          : {}),
        environmentId: input.environmentId,
        organizationId: input.organizationId,
        projectId: input.projectId,
      },
      resolved.manifest,
    );
    const configValidation = validateAgentDeploymentConfig(
      runtimeConfig ?? DEFAULT_DEPLOYMENT_CONFIG,
      resolved.manifest,
    );
    if (!configValidation.ok) {
      throw new ConversationError(
        "invalid_agent_deployment_config",
        issuesMessage(configValidation.issues),
      );
    }
    const [executionBindingId, eventId] = await Promise.all([
      options.generateId(),
      options.generateId(),
    ]);
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1_000).toISOString();
    const binding = Schema.decodeUnknownSync(ExecutionBindingRecord)(
      withCanonicalRecordKeys({
        data: {
          contentHash: resolved.contentHash,
          createdAt,
          createdBy: input.createdBy,
          environmentId: input.environmentId,
          expiresAt,
          id: executionBindingId,
          idempotencyKey: normalizedKey,
          manifest: resolved.manifest,
          organizationId: input.organizationId,
          projectId: input.projectId,
          purpose: input.purpose,
          ...(runtimeConfig === undefined ? {} : { runtimeConfig }),
          ...(input.runtimeConfigFromAgentDeploymentId
            ? { runtimeConfigSourceAgentDeploymentId: input.runtimeConfigFromAgentDeploymentId }
            : {}),
          source: resolved.source,
          status: "active" as const,
          toolPolicy: input.toolPolicy,
          updatedAt: createdAt,
          version: 0,
        },
        itemType: "execution-binding" as const,
        ttl: Math.floor(Date.parse(expiresAt) / 1_000),
      }),
    );
    const hostedCode = await persistence.snapshotHostedCodeTools(binding);
    if (hostedCode.issues.length > 0) {
      throw new ConversationError("invalid_agent_manifest", issuesMessage(hostedCode.issues));
    }
    const idempotency = Schema.decodeUnknownSync(IdempotencyRecord)(
      withCanonicalRecordKeys({
        data: {
          commandHash,
          createdAt,
          expiresAt,
          idempotencyKey,
          organizationId: input.organizationId,
          resourceIds: [executionBindingId],
          status: "completed" as const,
          version: 0,
        },
        itemType: "idempotency" as const,
        ttl: Math.floor(Date.parse(expiresAt) / 1_000),
      }),
    );
    const event = makeSemanticEventRecord({
      actor: input.createdBy,
      aggregateId: executionBindingId,
      aggregateType: "execution-binding",
      aggregateVersion: 1,
      environmentId: input.environmentId,
      eventId,
      eventType: "execution-binding.created",
      occurredAt: now,
      organizationId: input.organizationId,
      payload: internalSemanticEventPayload({
        contentHash: binding.data.contentHash,
        expiresAt,
        id: executionBindingId,
        purpose: input.purpose,
        toolPolicy: input.toolPolicy,
      }),
      projectId: input.projectId,
    });
    const committed = await persistence.create({
      binding,
      event,
      hostedCodeTools: hostedCode.pins,
      idempotency,
      transactionToken: createHash("sha256")
        .update(`execution-binding.create:${idempotencyKey}:${commandHash}`)
        .digest("hex")
        .slice(0, 36),
    });
    if (committed) return { binding, created: true };
    const winner = await replayExecutionBinding(input, idempotencyKey, commandHash, now);
    if (winner) return winner;
    throw new ConversationError("write_failed", "Execution binding could not be persisted.");
  }

  async function expireExecutionBinding(
    input: ExpireExecutionBindingInput,
  ): Promise<ExecutionBinding> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const previous = await getExecutionBinding(input);
      if (previous.data.status === "expired") return previous;
      const now = options.now?.() ?? new Date();
      const expiredAt = now.toISOString();
      const expired = Schema.decodeUnknownSync(ExecutionBindingRecord)(
        withCanonicalRecordKeys({
          data: {
            ...previous.data,
            expiredAt,
            status: "expired" as const,
            updatedAt: expiredAt,
            version: previous.data.version + 1,
          },
          itemType: "execution-binding" as const,
          ttl: previous.ttl,
        }),
      );
      const event = makeSemanticEventRecord({
        actor: input.actor,
        aggregateId: previous.data.id,
        aggregateType: "execution-binding",
        aggregateVersion: expired.data.version + 1,
        environmentId: previous.data.environmentId,
        eventId: await options.generateId(),
        eventType: "execution-binding.expired",
        occurredAt: now,
        organizationId: previous.data.organizationId,
        payload: internalSemanticEventPayload({ expiredAt, id: previous.data.id }),
        projectId: previous.data.projectId,
      });
      if (
        await persistence.expire({
          event,
          expired,
          previous,
          transactionToken: createHash("sha256")
            .update(`execution-binding.expire:${previous.data.id}:${expired.data.version}`)
            .digest("hex")
            .slice(0, 36),
        })
      ) {
        return expired;
      }
    }
    throw new ConversationError("write_conflict", "Execution binding changed concurrently.");
  }

  return { createExecutionBinding, expireExecutionBinding, getExecutionBinding };
}
