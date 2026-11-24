import {
  agentManifestContentHash,
  AgentDeploymentConfigV1,
  AgentManifestV1,
  ValidatedAgentManifestV1,
} from "@deployments-ai/agent-manifest";
import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import * as ControlFields from "./control-fields.ts";
import {
  HostedCodeContentHash,
  HostedCodeEntrypoint,
  HostedCodeNetworkMode,
  HostedCodeRuntimeLanguage,
  HostedCodeSourceLanguage,
} from "./hosted-code.ts";
import {
  BlobReference,
  DynamoValue,
  Metadata,
  NonEmptyString,
  NonNegativeSafeInteger,
  SecretReference,
  StringList,
  Timestamp,
  makeRecordSchema,
  mutableResourceFields,
  stateVersionFields,
  tenantScopeFields,
  workspaceScopeFields,
} from "../record-schema.ts";

const status = ControlFields.status;

export const AgentDefinitionRecord = makeRecordSchema("agent-definition", {
  ...mutableResourceFields,
  ...workspaceScopeFields,
  createdByPrincipalId: Ulid,
  draft: AgentManifestV1,
  id: Ulid,
  lastReleaseNumber: Schema.optional(NonNegativeSafeInteger),
  name: Schema.String,
  slug: NonEmptyString,
  status,
});

const AgentReleaseRecordBase = makeRecordSchema("agent-release", {
  ...stateVersionFields,
  ...tenantScopeFields,
  agentDefinitionId: Ulid,
  artifact: Schema.optional(BlobReference),
  contentHash: Schema.String,
  createdAt: Timestamp,
  createdByPrincipalId: Ulid,
  id: Ulid,
  manifest: ValidatedAgentManifestV1,
  promotedFromEnvironmentId: Schema.optional(Ulid),
  promotedFromReleaseId: Schema.optional(Ulid),
  releaseNumber: Schema.Number,
  status: Schema.Literals(["active", "archived", "draft"]),
});

export const AgentReleaseRecord = AgentReleaseRecordBase.pipe(
  Schema.check(
    Schema.makeFilter<typeof AgentReleaseRecordBase.Type>((record) =>
      record.data.contentHash === agentManifestContentHash(record.data.manifest)
        ? undefined
        : "Agent release contentHash must match the canonical manifest hash.",
    ),
  ),
);

const AgentDeploymentRecordBase = makeRecordSchema("agent-deployment", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  agentDefinitionId: Ulid,
  agentReleaseId: Ulid,
  candidateAgentReleaseId: Schema.optional(Ulid),
  candidateStartedAt: Schema.optional(Timestamp),
  candidateWeight: Schema.optional(
    Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 99 }))),
  ),
  currentState: Schema.Literals(["deploying", "failed", "paused", "ready", "stopped"]),
  desiredState: Schema.Literals(["paused", "running", "stopped"]),
  id: Ulid,
  lastTransitionAt: Schema.optional(Schema.String),
  runtimeConfig: Schema.optional(AgentDeploymentConfigV1),
});

export const AgentDeploymentRecord = AgentDeploymentRecordBase.pipe(
  Schema.check(
    Schema.makeFilter<typeof AgentDeploymentRecordBase.Type>(({ data }) => {
      const fields = [data.candidateAgentReleaseId, data.candidateStartedAt, data.candidateWeight];
      const present = fields.filter((field) => field !== undefined).length;
      if (present !== 0 && present !== fields.length) {
        return "Agent deployment canary fields must be set together.";
      }
      if (data.candidateAgentReleaseId === data.agentReleaseId) {
        return "Agent deployment canary candidate must differ from the primary release.";
      }
      return undefined;
    }),
  ),
);

export const AgentDefinitionReleaseIndexRecord = makeRecordSchema(
  "agent-definition-release-index",
  {
    ...stateVersionFields,
    ...tenantScopeFields,
    agentDefinitionId: Ulid,
    createdAt: Timestamp,
    id: Ulid,
    status: Schema.Literal("ready"),
  },
);

export const AgentReleaseControlRecord = makeRecordSchema("agent-release-control", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  activeDeploymentCount: NonNegativeSafeInteger,
  agentDefinitionId: Ulid,
  agentReleaseId: Ulid,
  id: Ulid,
  releaseNumber: NonNegativeSafeInteger,
});

export const ToolPolicyRecord = makeRecordSchema("tool-policy", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  id: Ulid,
  name: Schema.String,
  rules: Schema.Union([Schema.Array(Metadata), Metadata]),
  status,
});

const ToolPolicyAction = Schema.Literals(["allow", "deny", "require_approval"]);

/**
 * Definition-level fields that `makeToolAdapterRecord` stores beside the routing fields of every
 * execution variant. Public extension and vendor MCP writers never set them.
 */
const toolAdapterDefinitionFields = {
  auditMetadata: Schema.optional(DynamoValue),
  authorizationScopes: Schema.optional(StringList),
  defaultPolicyAction: Schema.optional(ToolPolicyAction),
  description: Schema.optional(Schema.String),
  hostPolicy: Schema.optional(DynamoValue),
  inputSchema: Schema.optional(DynamoValue),
  providerOutboundMutation: Schema.optional(Schema.Boolean),
  rateLimitPolicy: Schema.optional(DynamoValue),
  resourceMetadata: Schema.optional(DynamoValue),
  retryPolicy: Schema.optional(DynamoValue),
};

/**
 * How a tool adapter executes, as persisted. Hosted code stores only its declaration; the exact
 * artifact location is captured later by release and execution binding pins.
 */
export const ToolAdapterRecordExecution = Schema.Union([
  Schema.Struct({
    ...toolAdapterDefinitionFields,
    adapterKey: Schema.optional(Schema.String),
    type: Schema.Literal("builtin"),
  }),
  Schema.Struct({
    ...toolAdapterDefinitionFields,
    timeoutMs: Schema.optional(NonNegativeSafeInteger),
    type: Schema.Literal("client"),
  }),
  Schema.Struct({
    ...toolAdapterDefinitionFields,
    contentHash: HostedCodeContentHash,
    entrypoint: HostedCodeEntrypoint,
    language: HostedCodeRuntimeLanguage,
    memoryMiB: NonNegativeSafeInteger,
    network: HostedCodeNetworkMode,
    secretNames: StringList,
    sourceLanguage: HostedCodeSourceLanguage,
    timeoutMs: NonNegativeSafeInteger,
    type: Schema.Literal("hosted_code"),
  }),
  Schema.Struct({
    ...toolAdapterDefinitionFields,
    completionMode: Schema.optional(Schema.Literal("sync")),
    endpointOrigin: NonEmptyString,
    endpointPath: NonEmptyString,
    runContext: Schema.optional(Schema.Array(Schema.Literal("origin"))),
    type: Schema.Literal("http_callback"),
    workspaceFiles: Schema.optional(Schema.Struct({ include: StringList })),
  }),
  Schema.Struct({
    ...toolAdapterDefinitionFields,
    mcpServerId: Ulid,
    remoteToolName: NonEmptyString,
    type: Schema.Literal("mcp"),
  }),
  Schema.Struct({
    ...toolAdapterDefinitionFields,
    providerKey: NonEmptyString,
    remoteToolName: NonEmptyString,
    toolHash: NonEmptyString,
    type: Schema.Literal("vendor_mcp"),
  }),
]);
export type ToolAdapterRecordExecution = typeof ToolAdapterRecordExecution.Type;

export const ToolAdapterRecord = makeRecordSchema("tool-adapter", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  authSecretRef: Schema.optional(SecretReference),
  connectionId: Schema.optional(Ulid),
  defaultPolicyAction: Schema.optional(ToolPolicyAction),
  description: Schema.optional(Schema.String),
  effect: Schema.Literals(["execute", "read", "write"]),
  execution: ToolAdapterRecordExecution,
  id: Ulid,
  inputSchema: Schema.optional(Metadata),
  name: Schema.String,
  outputSchema: Schema.optional(Metadata),
  providerKey: Schema.optional(Schema.String),
  requiredScopes: StringList,
  status,
});

export const ManagedSkillSourceRecord = makeRecordSchema("managed-skill-source", {
  ...mutableResourceFields,
  id: Ulid,
  key: Schema.String,
  licenseHash: Schema.optional(Schema.String),
  metadata: Schema.optional(Metadata),
  name: Schema.String,
  pinnedCommit: Schema.optional(Schema.String),
  repositoryUrl: Schema.optional(Schema.String),
  status,
});

export const ManagedSkillReleaseRecord = makeRecordSchema("managed-skill-release", {
  ...stateVersionFields,
  activatedAt: Schema.optional(Schema.String),
  archivedAt: Schema.optional(Schema.String),
  contentHash: Schema.String,
  createdAt: Timestamp,
  id: Ulid,
  manifest: Metadata,
  sourceId: Ulid,
  status: Schema.Literals(["active", "archived", "draft"]),
  releaseVersion: Schema.String,
  skillIdsByKey: Schema.Record(Schema.String, Ulid),
  skillCount: NonNegativeSafeInteger,
});

export const ManagedSkillRecord = makeRecordSchema("managed-skill", {
  content: Schema.optional(BlobReference),
  contentText: Schema.optional(Schema.String),
  createdAt: Timestamp,
  dependencies: Schema.Array(Ulid),
  description: Schema.optional(Schema.String),
  id: Ulid,
  key: Schema.String,
  metadata: Schema.optional(Metadata),
  references: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  releaseId: Ulid,
  sourceId: Ulid,
});

export const ManagedSkillInstallationRecord = makeRecordSchema("managed-skill-installation", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  agentDefinitionId: Schema.optional(Ulid),
  id: Ulid,
  installedByPrincipalId: Ulid,
  managedSkillId: Ulid,
  managedSkillReleaseId: Ulid,
  status: Schema.Literals(["active", "removed", "superseded"]),
});
