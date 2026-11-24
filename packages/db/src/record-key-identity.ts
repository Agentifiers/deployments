import { createHash } from "node:crypto";
import { attributedCounterRecordKeyParts } from "./attributed-usage-keys.ts";
import { memorySearchIdentityParts } from "./memory-search-record-keys.ts";
import {
  CanonicalKeyError,
  field,
  requiredField,
  type KeyableRecord,
} from "./record-key-fields.ts";
import {
  conversationErasureIdentityParts,
  internetMessageIdHash,
} from "./thread-erasure/record-keys.ts";

export function identityHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function identityParts(record: KeyableRecord): readonly string[] {
  if (record.itemType === "message" || record.itemType === "timeline-event") {
    return [requiredField(record, "sequence").padStart(16, "0"), requiredField(record, "id")];
  }
  if (record.itemType === "conversation-checkpoint") {
    return [
      requiredField(record, "throughSequence").padStart(16, "0"),
      field(record.data, "throughMessageCharacterOffset")?.padStart(16, "0") ?? "~",
      requiredField(record, "id"),
    ];
  }

  const memoryIdentity = memorySearchIdentityParts(record, field, requiredField);
  if (memoryIdentity) return memoryIdentity;
  const erasureIdentity = conversationErasureIdentityParts(record);
  if (erasureIdentity) return erasureIdentity;

  switch (record.itemType) {
    case "governance-tenant-record":
      return [
        requiredField(record, "recordTable"),
        requiredField(record, "recordPk"),
        requiredField(record, "recordSk"),
      ];
    case "governance-operation-history":
      // Creation time first so the organization partition lists operations newest first.
      return [requiredField(record, "createdAt"), requiredField(record, "operationId")];
    case "governance-legacy-record":
      return [
        requiredField(record, "recordTable"),
        requiredField(record, "recordPk"),
        requiredField(record, "recordSk"),
      ];
    case "identity-security-event":
      return [requiredField(record, "aggregateVersion").padStart(16, "0")];
    case "operator-funded-spend-exhaustion":
      return [requiredField(record, "month")];
    case "organization-gate-lane":
      return [requiredField(record, "lane").padStart(2, "0")];
    case "brain-duplicate-pass":
    case "memory-search-index-drop-receipt":
    case "organization-egress-allowlist":
    case "organization-standing":
    case "principal-organization-creations":
      return [];
    case "organization-standing-change":
      return [requiredField(record, "standingVersion").padStart(16, "0")];
    case "inbox-control-created-index":
      return [
        requiredField(record, "resourceType"),
        requiredField(record, "createdAt"),
        requiredField(record, "id"),
      ];
    case "inbox-draft-created-index":
    case "inbox-message-created-index":
    case "inbox-message-thread-index":
    case "inbox-thread-created-index":
      return [requiredField(record, "createdAt"), requiredField(record, "id")];
    case "inbox-message-thread-alias":
      return [internetMessageIdHash(requiredField(record, "internetMessageId"))];
    case "agent-release-control":
      return [
        requiredField(record, "releaseNumber").padStart(16, "0"),
        requiredField(record, "id"),
      ];
    case "agent-release-hosted-code-tool":
    case "execution-binding-hosted-code-tool":
      return [requiredField(record, "toolName")];
    case "hosted-code-artifact":
      return [requiredField(record, "contentHash").replace(/^sha256:/u, "")];
    case "budget-period":
      return [requiredField(record, "periodStart")];
    case "monitor-state":
      return [requiredField(record, "monitorId")];
    case "monitor-signal":
      return [requiredField(record, "occurredAt"), requiredField(record, "eventId")];
    case "alert-notification-preference":
    case "organization-operator-access":
      return [requiredField(record, "principalId")];
    case "alert-email-delivery":
      return [requiredField(record, "eventId"), requiredField(record, "principalId")];
    case "scope-spend-shard":
      return [
        requiredField(record, "period"),
        requiredField(record, "periodStart"),
        requiredField(record, "shard").padStart(2, "0"),
      ];
    case "channel-delivery":
    case "brain-index-job":
    case "brain-sync-job":
    case "memory-flush":
    case "memory-index-job":
    case "run":
      return [requiredField(record, "idempotencyKey")];
    case "channel-delivery-lookup":
      return [requiredField(record, "deliveryId")];
    case "evaluation-case-run":
      return [requiredField(record, "caseKey")];
    case "score-definition-revision":
      return [requiredField(record, "revision").padStart(16, "0")];
    case "score-result":
      return [
        requiredField(record, "scoreDefinitionId"),
        requiredField(record, "revision").padStart(16, "0"),
      ];
    case "oauth-refresh-claim":
      return [requiredField(record, "connectionId"), requiredField(record, "credentialGeneration")];
    case "provider-mutation-claim":
      return [
        requiredField(record, "runId"),
        identityHash(requiredField(record, "idempotencyKey")),
      ];
    case "run-lookup":
      return [requiredField(record, "runId")];
    case "run-delegation":
      return [requiredField(record, "childRunId")];
    case "message-publication":
      return [requiredField(record, "runId")];
    case "slack-agent-stream":
    case "teams-agent-stream":
    case "agent-run-plan":
      return [requiredField(record, "runId")];
    case "sandbox-workspace":
      return [
        requiredField(record, "executionTargetKind"),
        requiredField(record, "executionTargetId"),
      ];
    case "workflow-execution-lookup":
      return [identityHash(requiredField(record, "idempotencyKey"))];
    case "workflow-step-correlation":
      return [requiredField(record, "externalKind"), requiredField(record, "externalId")];
    case "meter-event":
      return [requiredField(record, "idempotencyKey")];
    case "runtime-lease":
      return [requiredField(record, "leaseKey")];
    case "schedule-fire":
      return [requiredField(record, "scheduleId"), requiredField(record, "fireKey")];
    case "semantic-event":
      return [requiredField(record, "aggregateVersion").padStart(16, "0")];
    case "webhook-delivery-attempt":
      return [requiredField(record, "attempt").padStart(16, "0")];
    case "generation-reasoning":
      return [requiredField(record, "modelCallIndex").padStart(16, "0")];
    case "runtime-log-batch":
      return [
        requiredField(record, "attempt").padStart(8, "0"),
        requiredField(record, "batch").padStart(8, "0"),
      ];
    case "memory-index-verification-pass":
      return [
        requiredField(record, "targetId"),
        field(record.data, "workspaceId") ?? "ENVIRONMENT",
      ];
  }

  const id = field(record.data, "id");
  if (id) return [id];

  switch (record.itemType) {
    case "app-slug-reservation":
      return [requiredField(record, "slug")];
    case "audit-event":
      return [requiredField(record, "eventId")];
    case "command":
      return [requiredField(record, "commandId")];
    case "consumer-checkpoint":
      return [requiredField(record, "consumer"), requiredField(record, "shardId")];
    case "cost-aggregate":
      return [requiredField(record, "source"), requiredField(record, "bucket")];
    case "delivery-deduplication":
      return [requiredField(record, "consumer"), requiredField(record, "eventId")];
    case "idempotency":
      return [requiredField(record, "idempotencyKey")];
    case "inbox-usage":
      return [requiredField(record, "inboxId"), requiredField(record, "bucket")];
    case "organization-member":
      return [requiredField(record, "principalId")];
    case "projection-state":
      return [requiredField(record, "projectionType"), requiredField(record, "projectionId")];
    case "model-catalog-entry":
      return [requiredField(record, "modelId")];
    case "provider-definition":
      return [requiredField(record, "key")];
    case "brain-search-placement":
      return [requiredField(record, "organizationId")];
    case "brain-index-state":
      return [requiredField(record, "documentId")];
    case "brain-provider-mutation-claim":
      return [requiredField(record, "targetId")];
    case "provider-billing-period":
      return [requiredField(record, "provider"), requiredField(record, "periodStart")];
    case "provider-webhook-replay-claim":
      return [
        requiredField(record, "replayNamespace"),
        requiredField(record, "installationId"),
        requiredField(record, "providerEventIdOrHash"),
      ];
    case "memory-index-state":
      return [requiredField(record, "memoryId")];
    case "rate-limit-counter":
      return [
        requiredField(record, "scopeId"),
        requiredField(record, "limitKey"),
        requiredField(record, "window"),
      ];
    case "storage-usage":
      return [requiredField(record, "storageClass"), requiredField(record, "bucket")];
    case "usage-aggregate":
      return [requiredField(record, "metric"), requiredField(record, "bucket")];
    case "attributed-usage-counter-shard":
      return [
        ...attributedCounterRecordKeyParts(record),
        requiredField(record, "metric"),
        requiredField(record, "bucket"),
        requiredField(record, "shard"),
      ];
    case "usage-counter-shard":
      return [
        requiredField(record, "metric"),
        requiredField(record, "bucket"),
        requiredField(record, "shard"),
      ];
    case "unique-claim":
      return [requiredField(record, "namespace"), requiredField(record, "value")];
    default:
      throw new CanonicalKeyError({
        field: "id",
        itemType: record.itemType,
        message: `Record ${record.itemType} has no registered identity fields.`,
      });
  }
}
