import { Schema } from "effect";
import { EmailDomainRecord, EmailTenantRecord } from "./email.ts";
import {
  BrainDeploymentMountRecord,
  BrainContentStagingRecord,
  BrainDocumentRecord,
  BrainDocumentRenditionRecord,
  BrainDocumentVersionRecord,
  BrainGrantRecord,
  BrainRecord,
  BrainSourceOrderClaimRecord,
  BrainSourceRecord,
  BrainSourceItemClaimRecord,
  BrainSourceRevisionClaimRecord,
  BrainUploadLeaseRecord,
  BrainUploadTicketRecord,
} from "./brains.ts";
import {
  BrainIndexStateRecord,
  BrainProviderMutationClaimRecord,
  BrainSearchPlacementRecord,
} from "./brain-search.ts";
import { BrainEdgeRecord, BrainEntityRecord } from "./brain-graph.ts";
import {
  AgentDefinitionRecord,
  AgentDefinitionReleaseIndexRecord,
  AgentDeploymentRecord,
  AgentReleaseControlRecord,
  AgentReleaseRecord,
  ManagedSkillInstallationRecord,
  ManagedSkillRecord,
  ManagedSkillReleaseRecord,
  ManagedSkillSourceRecord,
  ToolAdapterRecord,
  ToolPolicyRecord,
} from "./agent-definitions.ts";
import {
  AgentReleaseHostedCodeToolRecord,
  ExecutionBindingHostedCodeToolRecord,
  HostedCodeArtifactRecord,
} from "./hosted-code.ts";
import { WorkflowDefinitionRecord, WorkflowReleaseRecord } from "./workflows.ts";
import { ModelCatalogEntryRecord, ModelPolicyRecord } from "./models.ts";
import {
  InboxBindingRecord,
  InboxControlCreatedIndexRecord,
  InboxDomainRecord,
  InboxPlacementRecord,
  InboxPolicyRecord,
  InboxProviderTenantRecord,
  InboxRecipientVerificationRecord,
  InboxRecord,
  InboxSubscriptionRecord,
  InboxSuppressionRecord,
} from "./inbox-configuration.ts";
import {
  ErasureFenceRecord,
  ErasureReceiptRecord,
  GovernanceOperationHistoryRecord,
  GovernanceOperationRecord,
  RetentionCleanupRecord,
  RetentionPolicyRecord,
  RetentionRestampRecord,
} from "./governance.ts";
import {
  ConversationErasureItemRecord,
  ConversationErasureMailItemRecord,
  EndUserErasureFenceRecord,
  EndUserInboxMailRecord,
  EndUserThreadRecord,
} from "./conversation-erasure.ts";
import {
  GovernanceInventoryStateRecord,
  GovernanceLegacyRecordRecord,
  GovernanceTenantRecordRecord,
} from "./governance-directory.ts";
import {
  PrincipalIdentityRecord,
  PrincipalRecord,
  UniqueClaimRecord,
  WorkspaceRecord,
} from "./identity.ts";
import {
  MemoryIndexStateRecord,
  MemoryIndexVerificationPassRecord,
  MemoryPolicyRecord,
  MemoryRecord,
  MemorySpaceGrantRecord,
  MemorySpaceRecord,
  RunLocatorRecord,
} from "./memory.ts";
import {
  MemoryDirectoryEntryRecord,
  MemoryDirectoryShardRecord,
  MemoryEmbeddingProfileRecord,
  MemoryErasureTargetReceiptRecord,
  MemoryProviderMutationClaimRecord,
  MemoryProviderMutationGateRecord,
  MemoryProviderPurgeCheckpointRecord,
  MemorySearchComponentRecord,
  MemorySearchPhysicalOwnerRecord,
  MemorySearchTargetIdentityRecord,
  MemorySearchTargetRecordRecord,
  MemorySearchEvidenceManifestRecord,
  MemorySearchIndexDropReceiptRecord,
  MemorySearchGenerationLiveShardRecord,
  MemorySearchGenerationLiveTargetRecord,
  MemorySearchGenerationRecord,
  MemorySearchGenerationTargetRecord,
  MemorySearchGenerationTargetShardRecord,
  MemorySearchMutationFenceRecord,
  MemorySearchPlacementRecord,
  MemorySearchProvisioningRecord,
  MemoryTargetCleanupReceiptRecord,
} from "./memory-search.ts";
import { ExecutionBindingRecord } from "./execution-bindings.ts";
import {
  ConnectionCapabilityRecord,
  ConnectionVerificationRecord,
  CredentialVaultEntryRecord,
  OAuthAuthorizationAttemptRecord,
  ProviderApplicationRecord,
  ProviderConnectionRecord,
  ProviderDefinitionRecord,
  WorkspaceConnectionAuthorizationRecord,
} from "./provider-connections.ts";
import {
  ChannelBindingRecord,
  McpConnectionRecord,
  McpServerRecord,
  SandboxPoolRecord,
  ScheduleRecord,
  WebhookEndpointRecord,
} from "./runtime-configuration.ts";
import { APP_CONTROL_RECORD_SCHEMAS } from "./apps.ts";
import { DIRECTORY_CONTROL_RECORD_SCHEMAS } from "./directory.ts";
import { FEDERATION_CONTROL_RECORD_SCHEMAS } from "./identity-federation.ts";
import { MODEL_CREDENTIAL_RECORD_SCHEMAS } from "./model-credentials.ts";
import { TENANCY_RECORD_SCHEMAS } from "./tenancy.ts";
import { EVALUATION_CONTROL_RECORD_SCHEMAS } from "./evaluations.ts";
import { SYSTEM_RECORD_SCHEMAS } from "./system.ts";
import { ORGANIZATION_STANDING_RECORD_SCHEMAS } from "./organization-standing.ts";
import { ORGANIZATION_CREATION_RECORD_SCHEMAS } from "./organization-creation.ts";
import { ORGANIZATION_GATE_RECORD_SCHEMAS } from "./organization-gate.ts";
import { MONITOR_CONTROL_RECORD_SCHEMAS } from "./monitors.ts";
import { OPERATOR_ACCESS_RECORD_SCHEMAS } from "./operator-access.ts";

export * from "./apps.ts";
export * from "./app-domains.ts";
export * from "./agent-definitions.ts";
export * from "./hosted-code.ts";
export * from "./directory.ts";
export * from "./brains.ts";
export * from "./brain-search.ts";
export * from "./brain-graph.ts";
export * from "./evaluations.ts";
export * from "./execution-bindings.ts";
export * from "./inbox-configuration.ts";
export * from "./governance.ts";
export * from "./governance-directory.ts";
export * from "./conversation-erasure.ts";
export * from "./identity.ts";
export * from "./identity-auth.ts";
export * from "./identity-envelope.ts";
export * from "./identity-federation.ts";
export * from "./identity-mfa.ts";
export * from "./identity-account.ts";
export * from "./memory.ts";
export * from "./memory-search.ts";
export * from "./models.ts";
export * from "./model-credentials.ts";
export * from "./provider-connections.ts";
export * from "./runtime-configuration.ts";
export * from "./system.ts";
export * from "./tenancy.ts";
export * from "./organization-standing.ts";
export * from "./organization-creation.ts";
export * from "./organization-gate.ts";
export * from "./monitors.ts";
export * from "./operator-access.ts";

export const CONTROL_RECORD_SCHEMAS = {
  ...TENANCY_RECORD_SCHEMAS,
  ...EVALUATION_CONTROL_RECORD_SCHEMAS,
  ...SYSTEM_RECORD_SCHEMAS,
  ...ORGANIZATION_STANDING_RECORD_SCHEMAS,
  ...ORGANIZATION_CREATION_RECORD_SCHEMAS,
  ...ORGANIZATION_GATE_RECORD_SCHEMAS,
  ...APP_CONTROL_RECORD_SCHEMAS,
  ...FEDERATION_CONTROL_RECORD_SCHEMAS,
  ...MODEL_CREDENTIAL_RECORD_SCHEMAS,
  ...DIRECTORY_CONTROL_RECORD_SCHEMAS,
  ...MONITOR_CONTROL_RECORD_SCHEMAS,
  ...OPERATOR_ACCESS_RECORD_SCHEMAS,
  "agent-definition": AgentDefinitionRecord,
  "agent-definition-release-index": AgentDefinitionReleaseIndexRecord,
  "agent-deployment": AgentDeploymentRecord,
  "agent-release": AgentReleaseRecord,
  "agent-release-control": AgentReleaseControlRecord,
  "agent-release-hosted-code-tool": AgentReleaseHostedCodeToolRecord,
  brain: BrainRecord,
  "brain-edge": BrainEdgeRecord,
  "brain-entity": BrainEntityRecord,
  "brain-deployment-mount": BrainDeploymentMountRecord,
  "brain-content-staging": BrainContentStagingRecord,
  "brain-document": BrainDocumentRecord,
  "brain-document-rendition": BrainDocumentRenditionRecord,
  "brain-document-version": BrainDocumentVersionRecord,
  "brain-grant": BrainGrantRecord,
  "brain-index-state": BrainIndexStateRecord,
  "brain-provider-mutation-claim": BrainProviderMutationClaimRecord,
  "brain-search-placement": BrainSearchPlacementRecord,
  "brain-source": BrainSourceRecord,
  "brain-source-item-claim": BrainSourceItemClaimRecord,
  "brain-source-order-claim": BrainSourceOrderClaimRecord,
  "brain-source-revision-claim": BrainSourceRevisionClaimRecord,
  "brain-upload-lease": BrainUploadLeaseRecord,
  "brain-upload-ticket": BrainUploadTicketRecord,
  "channel-binding": ChannelBindingRecord,
  "connection-capability": ConnectionCapabilityRecord,
  "connection-verification": ConnectionVerificationRecord,
  "credential-vault-entry": CredentialVaultEntryRecord,
  "email-domain": EmailDomainRecord,
  "email-tenant": EmailTenantRecord,
  "conversation-erasure-item": ConversationErasureItemRecord,
  "conversation-erasure-mail-item": ConversationErasureMailItemRecord,
  "end-user-erasure-fence": EndUserErasureFenceRecord,
  "end-user-inbox-mail": EndUserInboxMailRecord,
  "end-user-thread": EndUserThreadRecord,
  "erasure-fence": ErasureFenceRecord,
  "hosted-code-artifact": HostedCodeArtifactRecord,
  "erasure-receipt": ErasureReceiptRecord,
  "execution-binding": ExecutionBindingRecord,
  "execution-binding-hosted-code-tool": ExecutionBindingHostedCodeToolRecord,
  "governance-operation": GovernanceOperationRecord,
  "governance-operation-history": GovernanceOperationHistoryRecord,
  "governance-inventory-state": GovernanceInventoryStateRecord,
  "governance-legacy-record": GovernanceLegacyRecordRecord,
  "governance-tenant-record": GovernanceTenantRecordRecord,
  inbox: InboxRecord,
  "inbox-binding": InboxBindingRecord,
  "inbox-control-created-index": InboxControlCreatedIndexRecord,
  "inbox-domain": InboxDomainRecord,
  "inbox-placement": InboxPlacementRecord,
  "inbox-policy": InboxPolicyRecord,
  "inbox-provider-tenant": InboxProviderTenantRecord,
  "inbox-recipient-verification": InboxRecipientVerificationRecord,
  "inbox-subscription": InboxSubscriptionRecord,
  "inbox-suppression": InboxSuppressionRecord,
  "managed-skill": ManagedSkillRecord,
  "managed-skill-installation": ManagedSkillInstallationRecord,
  "managed-skill-release": ManagedSkillReleaseRecord,
  "managed-skill-source": ManagedSkillSourceRecord,
  "mcp-connection": McpConnectionRecord,
  "mcp-server": McpServerRecord,
  memory: MemoryRecord,
  "memory-directory-entry": MemoryDirectoryEntryRecord,
  "memory-directory-shard": MemoryDirectoryShardRecord,
  "memory-embedding-profile": MemoryEmbeddingProfileRecord,
  "memory-erasure-target-receipt": MemoryErasureTargetReceiptRecord,
  "memory-index-state": MemoryIndexStateRecord,
  "memory-index-verification-pass": MemoryIndexVerificationPassRecord,
  "memory-provider-mutation-claim": MemoryProviderMutationClaimRecord,
  "memory-provider-mutation-gate": MemoryProviderMutationGateRecord,
  "memory-provider-purge-checkpoint": MemoryProviderPurgeCheckpointRecord,
  "memory-policy": MemoryPolicyRecord,
  "memory-search-component": MemorySearchComponentRecord,
  "memory-search-physical-owner": MemorySearchPhysicalOwnerRecord,
  "memory-search-target-identity": MemorySearchTargetIdentityRecord,
  "memory-search-target-record": MemorySearchTargetRecordRecord,
  "memory-search-evidence-manifest": MemorySearchEvidenceManifestRecord,
  "memory-search-index-drop-receipt": MemorySearchIndexDropReceiptRecord,
  "memory-search-generation": MemorySearchGenerationRecord,
  "memory-search-generation-live-shard": MemorySearchGenerationLiveShardRecord,
  "memory-search-generation-live-target": MemorySearchGenerationLiveTargetRecord,
  "memory-search-generation-target": MemorySearchGenerationTargetRecord,
  "memory-search-generation-target-shard": MemorySearchGenerationTargetShardRecord,
  "memory-search-mutation-fence": MemorySearchMutationFenceRecord,
  "memory-search-placement": MemorySearchPlacementRecord,
  "memory-search-provisioning": MemorySearchProvisioningRecord,
  "memory-space": MemorySpaceRecord,
  "memory-space-grant": MemorySpaceGrantRecord,
  "memory-target-cleanup-receipt": MemoryTargetCleanupReceiptRecord,
  "model-catalog-entry": ModelCatalogEntryRecord,
  "model-policy": ModelPolicyRecord,
  "oauth-authorization-attempt": OAuthAuthorizationAttemptRecord,
  principal: PrincipalRecord,
  "principal-identity": PrincipalIdentityRecord,
  "provider-application": ProviderApplicationRecord,
  "provider-connection": ProviderConnectionRecord,
  "provider-definition": ProviderDefinitionRecord,
  "retention-policy": RetentionPolicyRecord,
  "retention-cleanup": RetentionCleanupRecord,
  "retention-restamp": RetentionRestampRecord,
  "run-locator": RunLocatorRecord,
  "sandbox-pool": SandboxPoolRecord,
  schedule: ScheduleRecord,
  "tool-adapter": ToolAdapterRecord,
  "tool-policy": ToolPolicyRecord,
  "unique-claim": UniqueClaimRecord,
  "webhook-endpoint": WebhookEndpointRecord,
  "workflow-definition": WorkflowDefinitionRecord,
  "workflow-release": WorkflowReleaseRecord,
  "workspace-connection-authorization": WorkspaceConnectionAuthorizationRecord,
  workspace: WorkspaceRecord,
} as const;

export const ControlRecord = Schema.Union(Object.values(CONTROL_RECORD_SCHEMAS));
export type ControlRecord = typeof ControlRecord.Type;
