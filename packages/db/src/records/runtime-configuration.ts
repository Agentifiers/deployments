import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import * as ControlFields from "./control-fields.ts";
import {
  ActorReference,
  Metadata,
  NonNegativeSafeInteger,
  SecretReference,
  StringList,
  Timestamp,
  makeRecordSchema,
  mutableResourceFields,
  tenantScopeFields,
  workspaceScopeFields,
} from "../record-schema.ts";

const status = ControlFields.status;

export const WebhookEndpointDisabledReason = Schema.Literals(["consecutive-failures", "manual"]);

export const WebhookEndpointRecord = makeRecordSchema("webhook-endpoint", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  /** Deliveries that exhausted their attempt budget since the last successful delivery. */
  consecutiveFailures: Schema.optional(NonNegativeSafeInteger),
  disabledAt: Schema.optional(Timestamp),
  disabledReason: Schema.optional(WebhookEndpointDisabledReason),
  eventTypes: StringList,
  id: Ulid,
  name: Schema.String,
  /** End of the rotation overlap during which the vault entry's previous secret also signs. */
  previousSigningSecretExpiresAt: Schema.optional(Timestamp),
  quotaSlot: Schema.optional(NonNegativeSafeInteger),
  resourceFilters: Schema.optional(Metadata),
  signingSecretRef: SecretReference,
  signingSecretRotatedAt: Schema.optional(Timestamp),
  status,
  url: Schema.String,
});

export const ChannelBindingRecord = makeRecordSchema("channel-binding", {
  ...mutableResourceFields,
  ...workspaceScopeFields,
  agentDefinitionId: Ulid,
  agentDeploymentId: Schema.optional(Ulid),
  channel: Schema.String,
  connectionId: Schema.optional(Ulid),
  creationHash: Schema.optional(Schema.String),
  credentialRef: Schema.optional(SecretReference),
  externalAccountId: Schema.optional(Schema.String),
  externalChannelId: Schema.optional(Schema.String),
  externalThreadKey: Schema.optional(Schema.String),
  externalWorkspaceId: Schema.optional(Schema.String),
  id: Ulid,
  lastVerifiedAt: Schema.optional(Timestamp),
  metadata: Schema.optional(Metadata),
  provider: Schema.String,
  status,
});

export const ScheduleRecord = makeRecordSchema("schedule", {
  ...mutableResourceFields,
  ...workspaceScopeFields,
  agentDeploymentId: Ulid,
  createdBy: Schema.optional(ActorReference),
  /** The agent tool call that created this schedule during a run. */
  createdFrom: Schema.optional(
    Schema.Struct({ runId: Ulid, threadId: Ulid, toolCallId: Ulid, toolName: Schema.String }),
  ),
  id: Ulid,
  name: Schema.String,
  nextRunAt: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  schedule: Metadata,
  status: Schema.Literals(["active", "archived", "paused", "provisioning"]),
  threadId: Schema.optional(Ulid),
});

export const SandboxPoolRecord = makeRecordSchema("sandbox-pool", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  displayName: Schema.String,
  egressPolicyRef: Schema.optional(Schema.String),
  id: Ulid,
  isolationMode: Schema.Literals(["run-ephemeral", "thread-persistent"]),
  poolKey: Schema.String,
  resourceProfile: Metadata,
  status,
});

export const McpServerRecord = makeRecordSchema("mcp-server", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  authSecretRef: Schema.optional(SecretReference),
  endpointOrigin: Schema.String,
  endpointPath: Schema.String,
  id: Ulid,
  name: Schema.String,
  status,
  toolAllowlist: StringList,
});

export const McpConnectionRecord = makeRecordSchema("mcp-connection", {
  ...mutableResourceFields,
  ...tenantScopeFields,
  connectionId: Schema.optional(Ulid),
  id: Ulid,
  mcpServerId: Ulid,
  status: Schema.Literals(["active", "error", "revoked"]),
});
