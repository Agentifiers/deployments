import { AgentDeploymentConfigV1, AgentManifestV1 } from "@deployments-ai/agent-manifest/schema";
import { ValidatedAgentManifestV1 } from "@deployments-ai/agent-manifest/semantics";
import { Schema } from "effect";
import { Cursor, PublicId, Timestamp } from "./primitives.ts";

const ResourceVersion = Schema.Number.pipe(
  Schema.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0, { message: "Resource versions must not be negative." }),
    Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER, {
      message: "Resource versions must be safe integers.",
    }),
  ),
);

const mutableFields = {
  createdAt: Timestamp,
  updatedAt: Timestamp,
  version: ResourceVersion,
} as const;

const tenantFields = {
  environmentId: PublicId,
  organizationId: PublicId,
  projectId: PublicId,
} as const;

export const CreateAgentDefinitionRequest = Schema.Struct({
  manifest: ValidatedAgentManifestV1,
  workspaceId: Schema.optional(
    PublicId.annotate({
      description:
        "Active workspace in the environment that owns the definition. The slug must be unique in that workspace. Set only on create.",
    }),
  ),
});

export const UpdateAgentDefinitionRequest = Schema.Struct({
  expectedVersion: ResourceVersion,
  manifest: ValidatedAgentManifestV1,
});

export const ArchiveAgentResourceRequest = Schema.Struct({
  expectedVersion: ResourceVersion,
});

export const PublishAgentReleaseRequest = Schema.Struct({
  expectedDefinitionVersion: ResourceVersion,
});

export const CreateAgentDeploymentRequest = Schema.Struct({
  agentReleaseId: PublicId,
  desiredState: Schema.optional(Schema.Literals(["paused", "running"])),
  runtimeConfig: Schema.optional(AgentDeploymentConfigV1),
});

export const UpdateAgentDeploymentRequest = Schema.Struct({
  /** Retarget (or roll back) the deployment to another active release of the same definition. */
  agentReleaseId: Schema.optional(PublicId),
  desiredState: Schema.optional(Schema.Literals(["paused", "running"])),
  expectedVersion: ResourceVersion,
  runtimeConfig: Schema.optional(AgentDeploymentConfigV1),
}).pipe(
  Schema.check(
    Schema.isMinProperties(2, {
      message:
        "Agent deployment updates must change agentReleaseId, desiredState, or runtimeConfig.",
    }),
  ),
);

const CanaryWeight = Schema.Number.pipe(
  Schema.check(
    Schema.isInt(),
    Schema.isBetween(
      { minimum: 1, maximum: 99 },
      { message: "Canary weight must be an integer from 1 to 99; promote or abort instead." },
    ),
  ),
);

export const StartAgentDeploymentCanaryRequest = Schema.Struct({
  candidateAgentReleaseId: PublicId,
  expectedVersion: ResourceVersion,
  /** Percentage of new threads routed to the candidate release. */
  weight: CanaryWeight,
});

export const ResolveAgentDeploymentCanaryRequest = Schema.Struct({
  expectedVersion: ResourceVersion,
});

export const PromoteAgentReleaseRequest = Schema.Struct({
  targetEnvironmentId: PublicId,
});

const agentDefinitionSummaryFields = {
  ...mutableFields,
  ...tenantFields,
  id: PublicId,
  name: Schema.String,
  slug: Schema.String,
  status: Schema.Literals(["active", "archived"]),
  workspaceId: Schema.optional(
    PublicId.annotate({
      description:
        "Workspace that owns the definition. Absent for a definition shared by the environment.",
    }),
  ),
} as const;

export const AgentDefinitionSummaryResponse = Schema.Struct(agentDefinitionSummaryFields);

export const AgentDefinitionResponse = Schema.Struct({
  ...agentDefinitionSummaryFields,
  draft: AgentManifestV1,
});

const agentReleaseSummaryFields = {
  ...tenantFields,
  agentDefinitionId: PublicId,
  contentHash: Schema.String.pipe(
    Schema.check(
      Schema.isPattern(/^sha256:[a-f0-9]{64}$/u, {
        message: "Agent release content hashes must be canonical SHA-256 values.",
      }),
    ),
  ),
  createdAt: Timestamp,
  createdByPrincipalId: PublicId,
  id: PublicId,
  releaseNumber: Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThan(0))),
  status: Schema.Literals(["active", "archived"]),
  version: ResourceVersion,
} as const;

export const AgentReleaseSummaryResponse = Schema.Struct(agentReleaseSummaryFields);

export const AgentReleaseResponse = Schema.Struct({
  ...agentReleaseSummaryFields,
  // Hash equality is enforced when a release is published and persisted. Keep this wire schema
  // browser-safe while validating the hash format and full manifest semantics synchronously.
  manifest: ValidatedAgentManifestV1,
});

export const AgentDeploymentResponse = Schema.Struct({
  ...mutableFields,
  ...tenantFields,
  agentDefinitionId: PublicId,
  agentReleaseId: PublicId,
  candidateAgentReleaseId: Schema.optional(PublicId),
  candidateStartedAt: Schema.optional(Timestamp),
  candidateWeight: Schema.optional(CanaryWeight),
  currentState: Schema.Literals(["deploying", "failed", "paused", "ready", "stopped"]),
  desiredState: Schema.Literals(["paused", "running", "stopped"]),
  id: PublicId,
  lastTransitionAt: Schema.optional(Timestamp),
  runtimeConfig: Schema.optional(AgentDeploymentConfigV1),
});

export const ListAgentDefinitionsResponse = Schema.Struct({
  items: Schema.Array(AgentDefinitionSummaryResponse),
  nextCursor: Schema.optional(Schema.NullOr(Cursor)),
});

export const ListAgentReleasesResponse = Schema.Struct({
  items: Schema.Array(AgentReleaseSummaryResponse),
  nextCursor: Schema.optional(Schema.NullOr(Cursor)),
});

export const ListAgentDeploymentsResponse = Schema.Struct({
  items: Schema.Array(AgentDeploymentResponse),
  nextCursor: Schema.optional(Schema.NullOr(Cursor)),
});

export type CreateAgentDefinitionRequest = typeof CreateAgentDefinitionRequest.Type;
export type UpdateAgentDefinitionRequest = typeof UpdateAgentDefinitionRequest.Type;
export type ArchiveAgentResourceRequest = typeof ArchiveAgentResourceRequest.Type;
export type PublishAgentReleaseRequest = typeof PublishAgentReleaseRequest.Type;
export type CreateAgentDeploymentRequest = typeof CreateAgentDeploymentRequest.Type;
export type UpdateAgentDeploymentRequest = typeof UpdateAgentDeploymentRequest.Type;
export type StartAgentDeploymentCanaryRequest = typeof StartAgentDeploymentCanaryRequest.Type;
export type ResolveAgentDeploymentCanaryRequest = typeof ResolveAgentDeploymentCanaryRequest.Type;
export type PromoteAgentReleaseRequest = typeof PromoteAgentReleaseRequest.Type;
export type AgentDefinitionResponse = typeof AgentDefinitionResponse.Type;
export type AgentDefinitionSummaryResponse = typeof AgentDefinitionSummaryResponse.Type;
export type AgentReleaseResponse = typeof AgentReleaseResponse.Type;
export type AgentReleaseSummaryResponse = typeof AgentReleaseSummaryResponse.Type;
export type AgentDeploymentResponse = typeof AgentDeploymentResponse.Type;

export function agentDefinitionResponse(input: unknown): AgentDefinitionResponse {
  return Schema.decodeUnknownSync(AgentDefinitionResponse)(input);
}

export function agentDefinitionSummaryResponse(input: unknown): AgentDefinitionSummaryResponse {
  return Schema.decodeUnknownSync(AgentDefinitionSummaryResponse)(input);
}

export function agentReleaseResponse(input: unknown): AgentReleaseResponse {
  return Schema.decodeUnknownSync(AgentReleaseResponse)(input);
}

export function agentReleaseSummaryResponse(input: unknown): AgentReleaseSummaryResponse {
  return Schema.decodeUnknownSync(AgentReleaseSummaryResponse)(input);
}

export function agentDeploymentResponse(input: unknown): AgentDeploymentResponse {
  return Schema.decodeUnknownSync(AgentDeploymentResponse)(input);
}
