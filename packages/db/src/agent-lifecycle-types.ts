import type { AgentDeploymentConfigV1 } from "@deployments-ai/agent-manifest";
import type {
  makeAgentLifecycleRecordStore,
  makeAgentReleaseControlRecord,
} from "./agent-lifecycle-storage.ts";
import type { AdmitManifest, ManifestAdmissionTarget } from "./agent-model-admission.ts";
import type { DynamoDatabaseService, TransactionOperation } from "./client-types.ts";
import type { Ulid } from "./ids.ts";
import type { PersistenceInvocation, PersistenceListResult } from "./persistence-types.ts";
import type {
  AgentDefinitionRecord,
  AgentDeploymentRecord,
  AgentReleaseRecord,
} from "./records/control.ts";
import type { makeSemanticEventRecord } from "./semantic-event-storage.ts";
import type { TenancyPersistence } from "./tenancy.ts";

export type AgentDefinition = typeof AgentDefinitionRecord.Type;
export type AgentDeployment = typeof AgentDeploymentRecord.Type;
export type AgentRelease = typeof AgentReleaseRecord.Type;

export type AgentDefinitionResult = Omit<
  AgentDefinition["data"],
  "createdByPrincipalId" | "lastReleaseNumber"
>;
export type AgentDefinitionSummaryResult = Omit<AgentDefinitionResult, "draft">;
export type AgentDeploymentResult = AgentDeployment["data"];
export type AgentReleaseResult = Omit<AgentRelease["data"], "artifact">;
export type AgentReleaseSummaryResult = Omit<AgentReleaseResult, "manifest">;

export interface CreateAgentDefinitionInput {
  readonly manifest: AgentDefinition["data"]["draft"];
  readonly workspaceId?: string | undefined;
}

export interface UpdateAgentDefinitionInput {
  readonly expectedVersion: number;
  readonly manifest: AgentDefinition["data"]["draft"];
}

export interface ArchiveAgentResourceInput {
  readonly expectedVersion: number;
}

export interface PublishAgentReleaseInput {
  readonly expectedDefinitionVersion: number;
}

export interface CreateAgentDeploymentInput {
  readonly agentReleaseId: string;
  readonly desiredState?: "paused" | "running" | undefined;
  readonly runtimeConfig?: AgentDeploymentConfigV1 | undefined;
}

export interface UpdateAgentDeploymentInput {
  readonly agentReleaseId?: string | undefined;
  readonly desiredState?: "paused" | "running" | undefined;
  readonly expectedVersion: number;
  readonly runtimeConfig?: AgentDeploymentConfigV1 | undefined;
}

interface StartAgentDeploymentCanaryInput {
  readonly candidateAgentReleaseId: string;
  readonly expectedVersion: number;
  readonly weight: number;
}

interface PromoteAgentReleaseInput {
  readonly targetEnvironmentId: string;
}

interface AgentReleasePromotionResult {
  readonly created: boolean;
  readonly release: AgentReleaseResult;
}

export interface AgentDefinitionPersistence {
  list(
    invocation: PersistenceInvocation<undefined>,
  ): Promise<PersistenceListResult<AgentDefinitionSummaryResult>>;
  create(
    invocation: PersistenceInvocation<CreateAgentDefinitionInput>,
  ): Promise<AgentDefinitionResult>;
  get(invocation: PersistenceInvocation<undefined>): Promise<AgentDefinitionResult>;
  update(
    invocation: PersistenceInvocation<UpdateAgentDefinitionInput>,
  ): Promise<AgentDefinitionResult>;
  archive(
    invocation: PersistenceInvocation<ArchiveAgentResourceInput>,
  ): Promise<AgentDefinitionResult>;
}

export interface AgentReleasePersistence {
  list(
    invocation: PersistenceInvocation<undefined>,
  ): Promise<PersistenceListResult<AgentReleaseSummaryResult>>;
  publish(invocation: PersistenceInvocation<PublishAgentReleaseInput>): Promise<AgentReleaseResult>;
  promote(
    invocation: PersistenceInvocation<PromoteAgentReleaseInput>,
  ): Promise<AgentReleasePromotionResult>;
  get(invocation: PersistenceInvocation<undefined>): Promise<AgentReleaseResult>;
  archive(
    invocation: PersistenceInvocation<ArchiveAgentResourceInput>,
  ): Promise<AgentReleaseResult>;
}

export interface AgentDeploymentPersistence {
  list(
    invocation: PersistenceInvocation<undefined>,
  ): Promise<PersistenceListResult<AgentDeploymentResult>>;
  create(
    invocation: PersistenceInvocation<CreateAgentDeploymentInput>,
  ): Promise<AgentDeploymentResult>;
  get(invocation: PersistenceInvocation<undefined>): Promise<AgentDeploymentResult>;
  update(
    invocation: PersistenceInvocation<UpdateAgentDeploymentInput>,
  ): Promise<AgentDeploymentResult>;
  stop(
    invocation: PersistenceInvocation<ArchiveAgentResourceInput>,
  ): Promise<AgentDeploymentResult>;
  startCanary(
    invocation: PersistenceInvocation<StartAgentDeploymentCanaryInput>,
  ): Promise<AgentDeploymentResult>;
  promoteCanary(
    invocation: PersistenceInvocation<ArchiveAgentResourceInput>,
  ): Promise<AgentDeploymentResult>;
  abortCanary(
    invocation: PersistenceInvocation<ArchiveAgentResourceInput>,
  ): Promise<AgentDeploymentResult>;
}

export interface AgentLifecyclePersistence {
  readonly agentDefinitions: AgentDefinitionPersistence;
  readonly agentDeployments: AgentDeploymentPersistence;
  readonly agentReleases: AgentReleasePersistence;
}

export type PlatformPersistence = TenancyPersistence & AgentLifecyclePersistence;

export interface AgentEnvironmentScope {
  readonly id: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
}

export interface AgentLifecyclePersistenceDependencies {
  readonly admitManifest: AdmitManifest;
  readonly database: DynamoDatabaseService;
  readonly generateId?: () => Promise<string>;
  readonly now?: () => Date;
  readonly resolveEnvironment: (
    invocation: PersistenceInvocation,
  ) => Promise<AgentEnvironmentScope | undefined>;
}

type AgentReleaseControl = ReturnType<typeof makeAgentReleaseControlRecord>;
type AgentReleaseControlState =
  | {
      readonly persisted: true;
      readonly record: AgentReleaseControl;
      readonly release: AgentRelease;
    }
  | {
      readonly persisted: false;
      readonly record: AgentReleaseControl;
      readonly release: AgentRelease;
    };

export interface AgentLifecycleContext {
  readonly allPartitionRecords: <T extends AgentDeployment | AgentRelease>(
    scope: { readonly id: string; readonly organizationId: string },
    itemType: T["itemType"],
  ) => Promise<T[]>;
  /** Throws `unprocessable` with the first issue's code when a manifest reference is not admitted. */
  readonly assertManifestAdmitted: (target: ManifestAdmissionTarget) => Promise<void>;
  readonly dependencies: AgentLifecyclePersistenceDependencies;
  readonly derivedActiveDeploymentCount: (release: AgentRelease) => Promise<number>;
  readonly environmentFor: (invocation: PersistenceInvocation) => Promise<AgentEnvironmentScope>;
  readonly generateId: () => Promise<string>;
  readonly getAgentRecord: <T extends AgentDefinition | AgentDeployment | AgentRelease>(
    invocation: PersistenceInvocation,
    itemType: T["itemType"],
    label: string,
  ) => Promise<T>;
  readonly lastReleaseNumber: (definition: AgentDefinition) => Promise<number>;
  readonly lifecycleEvent: (
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
  ) => Promise<ReturnType<typeof makeSemanticEventRecord>>;
  readonly listEnvironmentRecords: <T extends AgentDefinition | AgentDeployment>(
    invocation: PersistenceInvocation,
    itemType: T["itemType"],
  ) => Promise<{ readonly items: T[]; readonly nextCursor: string | null }>;
  readonly now: () => Date;
  readonly recordStore: ReturnType<typeof makeAgentLifecycleRecordStore>;
  readonly releaseControlFor: (release: AgentRelease) => Promise<AgentReleaseControlState>;
  readonly releaseControlPut: (
    current: AgentReleaseControlState,
    timestamp: string,
    activeDeploymentCount: number,
  ) => TransactionOperation;
}
