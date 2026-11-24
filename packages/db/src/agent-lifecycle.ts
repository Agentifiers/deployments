import { Schema } from "effect";
import { makeAgentDefinitionPersistence } from "./agent-definition-persistence.ts";
import { makeAgentDeploymentPersistence } from "./agent-deployment-persistence.ts";
import {
  InvalidAgentRecordCursorError,
  makeAgentLifecycleRecordStore,
  makeAgentReleaseControlRecord,
  updateAgentReleaseControlRecord,
} from "./agent-lifecycle-storage.ts";
import type {
  AgentDefinition,
  AgentDeployment,
  AgentEnvironmentScope,
  AgentLifecycleContext,
  AgentLifecyclePersistence,
  AgentLifecyclePersistenceDependencies,
  AgentRelease,
  PlatformPersistence,
} from "./agent-lifecycle-types.ts";
import { assertManifestAdmitted } from "./agent-model-admission.ts";
import { makeAgentReleasePersistence } from "./agent-release-persistence.ts";
import { DatabaseError, type TransactionOperation } from "./client-types.ts";
import { Ulid, makeIdGenerator } from "./ids.ts";
import { PersistenceError, type PersistenceInvocation } from "./persistence-types.ts";
import {
  AgentDefinitionRecord,
  AgentDeploymentRecord,
  AgentReleaseRecord,
} from "./records/control.ts";
import { type PlatformRecord, withCanonicalRecordKeys } from "./records/index.ts";
import { makeSemanticEventRecord } from "./semantic-event-storage.ts";
import type { TenancyPersistence } from "./tenancy.ts";
import { requiredResourceId } from "./tenancy-contracts.ts";
import { isDatabaseWriteConflict } from "./transaction-conditions.ts";
import { makeUniqueClaimRecord, uniqueClaimRequirements } from "./unique-claims.ts";

export const DEFAULT_DEPLOYMENT_CONFIG = {
  apiVersion: "agents.deployments.ai/v1",
  kind: "AgentDeploymentConfig",
} as const;

export function agentDefinitionResult(input: AgentDefinition["data"]) {
  return {
    createdAt: input.createdAt,
    draft: input.draft,
    environmentId: input.environmentId,
    id: input.id,
    name: input.name,
    organizationId: input.organizationId,
    projectId: input.projectId,
    slug: input.slug,
    status: input.status,
    updatedAt: input.updatedAt,
    version: input.version,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
  };
}

export function agentDefinitionSummaryResult(input: AgentDefinition["data"]) {
  const { draft: _draft, ...summary } = agentDefinitionResult(input);
  return summary;
}

export function agentReleaseResult(input: AgentRelease["data"]) {
  return {
    agentDefinitionId: input.agentDefinitionId,
    contentHash: input.contentHash,
    createdAt: input.createdAt,
    createdByPrincipalId: input.createdByPrincipalId,
    environmentId: input.environmentId,
    id: input.id,
    manifest: input.manifest,
    organizationId: input.organizationId,
    projectId: input.projectId,
    releaseNumber: input.releaseNumber,
    status: input.status,
    version: input.version,
  };
}

export function agentReleaseSummaryResult(input: AgentRelease["data"]) {
  const { manifest: _manifest, ...summary } = agentReleaseResult(input);
  return summary;
}

export function agentDeploymentResult(input: AgentDeployment["data"]) {
  return {
    agentDefinitionId: input.agentDefinitionId,
    agentReleaseId: input.agentReleaseId,
    ...(input.candidateAgentReleaseId
      ? {
          candidateAgentReleaseId: input.candidateAgentReleaseId,
          candidateStartedAt: input.candidateStartedAt,
          candidateWeight: input.candidateWeight,
        }
      : {}),
    createdAt: input.createdAt,
    currentState: input.currentState,
    desiredState: input.desiredState,
    environmentId: input.environmentId,
    id: input.id,
    ...(input.lastTransitionAt ? { lastTransitionAt: input.lastTransitionAt } : {}),
    organizationId: input.organizationId,
    projectId: input.projectId,
    ...(input.runtimeConfig ? { runtimeConfig: input.runtimeConfig } : {}),
    updatedAt: input.updatedAt,
    version: input.version,
  };
}

export function id(value: string): Ulid {
  return Schema.decodeUnknownSync(Ulid)(value);
}

function requiredEnvironmentId(invocation: PersistenceInvocation): Ulid {
  const environmentId = invocation.scope.environmentId;
  if (!environmentId) {
    throw new PersistenceError(
      "invalid-input",
      "environment_scope_required",
      "An environment scope is required.",
    );
  }
  return id(environmentId);
}

export async function databaseValue<A>(
  promise: Promise<A>,
  conflict?: { readonly code: string; readonly message: string },
): Promise<A> {
  try {
    return await promise;
  } catch (cause) {
    if (cause instanceof PersistenceError) throw cause;
    if (cause instanceof InvalidAgentRecordCursorError) {
      throw new PersistenceError(
        "invalid-input",
        "invalid_cursor",
        "The pagination cursor is invalid.",
      );
    }
    if (cause instanceof DatabaseError && conflict && isDatabaseWriteConflict(cause)) {
      throw new PersistenceError("conflict", conflict.code, conflict.message);
    }
    throw new PersistenceError(
      "internal",
      "persistence_error",
      "Agent lifecycle persistence failed.",
    );
  }
}

export async function databaseWriteAttempt(promise: Promise<void>): Promise<boolean> {
  try {
    await promise;
    return true;
  } catch (cause) {
    if (cause instanceof DatabaseError && isDatabaseWriteConflict(cause)) return false;
    throw new PersistenceError(
      "internal",
      "persistence_error",
      "Agent lifecycle persistence failed.",
    );
  }
}

export function expectedVersion(actual: number, expected: number) {
  if (actual !== expected) {
    throw new PersistenceError("conflict", "version_conflict", "The resource version has changed.");
  }
}

export function validationMessage(
  issues: readonly { readonly message: string; readonly path: string }[],
) {
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n");
}

export function definitionRecord(input: {
  readonly environment: AgentEnvironmentScope;
  readonly manifest: AgentDefinition["data"]["draft"];
  readonly principalId: Ulid;
  readonly resourceId: Ulid;
  readonly timestamp: string;
  readonly workspaceId?: Ulid;
}): AgentDefinition {
  return Schema.decodeUnknownSync(AgentDefinitionRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: input.timestamp,
        createdByPrincipalId: input.principalId,
        draft: structuredClone(input.manifest),
        environmentId: id(input.environment.id),
        id: input.resourceId,
        lastReleaseNumber: 0,
        name: input.manifest.metadata.name,
        organizationId: id(input.environment.organizationId),
        projectId: id(input.environment.projectId),
        slug: input.manifest.metadata.key,
        status: "active" as const,
        updatedAt: input.timestamp,
        version: 0,
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      },
      itemType: "agent-definition" as const,
    }),
  );
}

export function updatedDefinition(
  previous: AgentDefinition,
  timestamp: string,
  changes: Partial<AgentDefinition["data"]>,
): AgentDefinition {
  return Schema.decodeUnknownSync(AgentDefinitionRecord)(
    withCanonicalRecordKeys({
      data: {
        ...previous.data,
        ...changes,
        updatedAt: timestamp,
        version: previous.data.version + 1,
      },
      itemType: "agent-definition" as const,
    }),
  );
}

export function updatedRelease(
  previous: AgentRelease,
  changes: Partial<AgentRelease["data"]>,
): AgentRelease {
  return Schema.decodeUnknownSync(AgentReleaseRecord)(
    withCanonicalRecordKeys({
      data: { ...previous.data, ...changes, version: previous.data.version + 1 },
      itemType: "agent-release" as const,
    }),
  );
}

export function updatedDeployment(
  previous: AgentDeployment,
  timestamp: string,
  changes: Partial<AgentDeployment["data"]>,
): AgentDeployment {
  return Schema.decodeUnknownSync(AgentDeploymentRecord)(
    withCanonicalRecordKeys({
      data: {
        ...previous.data,
        ...changes,
        updatedAt: timestamp,
        version: previous.data.version + 1,
      },
      itemType: "agent-deployment" as const,
    }),
  );
}

export function uniqueClaim(record: AgentDefinition, timestamp: string) {
  const [requirement] = uniqueClaimRequirements(record);
  if (!requirement) {
    throw new PersistenceError(
      "internal",
      "persistence_error",
      "Agent definition uniqueness is not registered.",
    );
  }
  return makeUniqueClaimRecord(requirement, timestamp) as Extract<
    PlatformRecord,
    { readonly itemType: "unique-claim" }
  >;
}
function makeAgentLifecycleContext(
  dependencies: AgentLifecyclePersistenceDependencies,
): AgentLifecycleContext {
  const idGenerator = makeIdGenerator();
  const now = dependencies.now ?? (() => new Date());
  const generateId = dependencies.generateId ?? (async () => idGenerator.generate());
  const recordStore = makeAgentLifecycleRecordStore(dependencies.database);

  async function nextSemanticEventVersion(
    organizationId: Ulid,
    aggregateType: string,
    aggregateId: Ulid,
  ) {
    const latest = await databaseValue(
      recordStore.getLatestSemanticEvent(organizationId, aggregateType, aggregateId),
    );
    return latest?.itemType === "semantic-event" ? latest.data.aggregateVersion + 1 : 1;
  }

  async function lifecycleEvent(
    invocation: PersistenceInvocation,
    input: {
      readonly aggregateId: Ulid;
      readonly aggregateType: string;
      readonly aggregateVersion?: number;
      readonly environmentId: Ulid;
      readonly eventType: string;
      readonly occurredAt: string;
      readonly organizationId: Ulid;
      readonly payload: Readonly<Record<string, string | number | boolean | null>>;
      readonly projectId: Ulid;
    },
  ) {
    return makeSemanticEventRecord({
      actor: { id: id(invocation.identity.principalId), type: "principal" },
      ...input,
      aggregateVersion:
        input.aggregateVersion ??
        (await nextSemanticEventVersion(
          input.organizationId,
          input.aggregateType,
          input.aggregateId,
        )),
      eventId: id(await generateId()),
    });
  }

  async function environmentFor(invocation: PersistenceInvocation) {
    const requestedId = requiredEnvironmentId(invocation);
    const environment = await dependencies.resolveEnvironment(invocation);
    if (!environment || String(environment.id) !== String(requestedId)) {
      throw new PersistenceError("not-found", "resource_not_found", "Environment was not found.");
    }
    return environment;
  }

  async function getAgentRecord<T extends AgentDefinition | AgentDeployment | AgentRelease>(
    invocation: PersistenceInvocation,
    itemType: T["itemType"],
    label: string,
  ): Promise<T> {
    const environment = await environmentFor(invocation);
    const resourceId = requiredResourceId(invocation);
    const record = await databaseValue(
      recordStore.getEnvironmentRecord(
        {
          environmentId: environment.id,
          organizationId: environment.organizationId,
        },
        itemType,
        resourceId,
      ),
    );
    if (!record || record.itemType !== itemType) {
      throw new PersistenceError("not-found", "resource_not_found", `${label} was not found.`);
    }
    return record as T;
  }

  async function listEnvironmentRecords<T extends AgentDefinition | AgentDeployment>(
    invocation: PersistenceInvocation,
    itemType: T["itemType"],
  ) {
    const environment = await environmentFor(invocation);
    const result = await databaseValue(
      recordStore.listEnvironmentRecords(environment.id, itemType, {
        ...(invocation.query.cursor ? { cursor: invocation.query.cursor } : {}),
        limit: invocation.query.limit ?? 50,
      }),
    );
    return {
      items: result.items.filter(
        (record): record is T =>
          record.itemType === itemType &&
          String(record.data.environmentId) === String(environment.id),
      ),
      nextCursor: result.nextCursor,
    };
  }

  async function allPartitionRecords<T extends AgentDeployment | AgentRelease>(
    scope: { readonly id: string; readonly organizationId: string },
    itemType: T["itemType"],
  ): Promise<T[]> {
    const records = await databaseValue(
      recordStore.listAllEnvironmentRecords(
        { environmentId: scope.id, organizationId: scope.organizationId },
        itemType,
      ),
    );
    return records.filter((record): record is T => record.itemType === itemType);
  }

  async function lastReleaseNumber(definition: AgentDefinition) {
    if (definition.data.lastReleaseNumber !== undefined) {
      return definition.data.lastReleaseNumber;
    }
    const releases = await allPartitionRecords<AgentRelease>(
      { id: definition.data.environmentId, organizationId: definition.data.organizationId },
      "agent-release",
    );
    return Math.max(
      0,
      ...releases
        .filter((release) => release.data.agentDefinitionId === definition.data.id)
        .map((release) => release.data.releaseNumber),
    );
  }

  async function derivedActiveDeploymentCount(release: AgentRelease) {
    const deployments = await allPartitionRecords<AgentDeployment>(
      { id: release.data.environmentId, organizationId: release.data.organizationId },
      "agent-deployment",
    );
    return deployments.filter(
      (deployment) =>
        (deployment.data.agentReleaseId === release.data.id ||
          deployment.data.candidateAgentReleaseId === release.data.id) &&
        deployment.data.currentState !== "stopped",
    ).length;
  }

  async function releaseControlFor(release: AgentRelease) {
    const record = await databaseValue(recordStore.getReleaseControl(release));
    if (record?.itemType === "agent-release-control") {
      return { persisted: true as const, record, release };
    }
    return {
      persisted: false as const,
      record: makeAgentReleaseControlRecord(
        release,
        now().toISOString(),
        await derivedActiveDeploymentCount(release),
      ),
      release,
    };
  }

  function releaseControlPut(
    current: Awaited<ReturnType<typeof releaseControlFor>>,
    timestamp: string,
    activeDeploymentCount: number,
  ): TransactionOperation {
    if (!current.persisted) {
      return {
        kind: "put",
        record: makeAgentReleaseControlRecord(current.release, timestamp, activeDeploymentCount),
      };
    }
    return {
      kind: "put",
      previousRecord: current.record,
      record: updateAgentReleaseControlRecord(current.record, timestamp, activeDeploymentCount),
    };
  }
  return {
    allPartitionRecords,
    assertManifestAdmitted: (target) => assertManifestAdmitted(dependencies.admitManifest, target),
    dependencies,
    derivedActiveDeploymentCount,
    environmentFor,
    generateId,
    getAgentRecord,
    lastReleaseNumber,
    lifecycleEvent,
    listEnvironmentRecords,
    now,
    recordStore,
    releaseControlFor,
    releaseControlPut,
  };
}

export function makeAgentLifecyclePersistence(
  dependencies: AgentLifecyclePersistenceDependencies,
): AgentLifecyclePersistence {
  const context = makeAgentLifecycleContext(dependencies);
  return {
    agentDefinitions: makeAgentDefinitionPersistence(context),
    agentDeployments: makeAgentDeploymentPersistence(context),
    agentReleases: makeAgentReleasePersistence(context),
  };
}

export function withAgentLifecyclePersistence(
  service: TenancyPersistence,
  dependencies: Omit<AgentLifecyclePersistenceDependencies, "resolveEnvironment">,
): PlatformPersistence {
  const agents = makeAgentLifecyclePersistence({
    ...dependencies,
    resolveEnvironment: async (invocation) => {
      const environmentId = invocation.scope.environmentId;
      if (!environmentId) return undefined;
      const environment = await service.environments.get({
        ...invocation,
        body: undefined,
        id: environmentId,
      });
      return {
        id: environment.id,
        organizationId: environment.organizationId,
        projectId: environment.projectId,
      };
    },
  });
  return { ...service, ...agents };
}
