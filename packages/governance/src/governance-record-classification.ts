import { RETENTION_TTL_CLASS_BY_ITEM_TYPE, type PlatformRecord } from "@deployments-ai/db";
import { DAY_MILLISECONDS } from "./governance-service-support.ts";
import type { RetentionClass, RetentionPolicy } from "./types.ts";

// Item types whose retention class does not depend on their data.
const RETENTION_CLASS_BY_ITEM_TYPE: Readonly<
  Partial<Record<PlatformRecord["itemType"], RetentionClass>>
> = {
  ...RETENTION_TTL_CLASS_BY_ITEM_TYPE,
  thread: "threads",
  "inbox-thread": "threads",
  "inbound-thread-route": "threads",
  "sandbox-workspace": "threads",
  "stream-session": "threads",
  message: "messages",
  "conversation-checkpoint": "messages",
  "inbox-draft": "messages",
  "inbox-message": "messages",
  run: "runs",
  "run-delegation": "runs",
  "run-edge": "runs",
  "run-lookup": "runs",
  "message-publication": "runs",
  trace: "runs",
  "model-invocation": "runs",
  "generation-reasoning": "runs",
  "runtime-log-batch": "runs",
  "tool-call": "runs",
  approval: "runs",
  "callback-dispatch-evidence": "runs",
  "brain-index-job": "runs",
  "brain-review-item": "runs",
  "brain-sync-job": "runs",
  "channel-delivery": "runs",
  "channel-delivery-lookup": "runs",
  "heartbeat-run": "runs",
  "image-job": "runs",
  "memory-flush": "runs",
  "memory-index-job": "runs",
  "memory-shadow-job": "runs",
  "pdf-job": "runs",
  "provider-mutation-claim": "runs",
  "slack-agent-stream": "runs",
  "teams-agent-stream": "runs",
  "agent-run-plan": "runs",
  annotation: "runs",
  "evaluation-case-run": "runs",
  "evaluation-run": "runs",
  "release-comparison": "runs",
  "score-result": "runs",
  "runtime-lease": "runs",
  artifact: "artifacts",
  "inbox-attachment": "artifacts",
  "inbox-provider-event": "events",
  command: "events",
  "webhook-delivery": "events",
  "webhook-delivery-attempt": "events",
  "timeline-event": "events",
  "audit-event": "audit",
  "immutable-audit-export": "audit",
};

export function retentionClass(record: PlatformRecord): RetentionClass | undefined {
  switch (record.itemType) {
    case "sandbox-lease":
    case "schedule-fire":
      return typeof (record.data as Readonly<Record<string, unknown>>).runId === "string"
        ? "runs"
        : undefined;
    case "governance-operation":
    case "governance-operation-history":
      if (record.data.kind === "tenant-export") return "artifacts";
      if (record.data.kind === "audit-export") return "audit";
      return undefined;
    default:
      return RETENTION_CLASS_BY_ITEM_TYPE[record.itemType];
  }
}

/**
 * The shortest age, measured from `governanceRecordTimestamp`, at which retention can expire a
 * record of this item type under `policy`: `undefined` when retention never expires the type and
 * `0` when the record carries its own expiry instead of a class age. A record younger than this
 * cannot be due, so retention need not read it.
 */
export function retentionMinimumAgeMilliseconds(
  itemType: string,
  policy: RetentionPolicy,
): number | undefined {
  switch (itemType) {
    case "sandbox-lease":
    case "schedule-fire":
      return policy.runs * DAY_MILLISECONDS;
    case "governance-operation-history":
      return Math.min(policy.artifacts, policy.audit) * DAY_MILLISECONDS;
    // Audit exports expire at their recorded retainedUntil instead of an age.
    case "governance-operation":
    case "immutable-audit-export":
    // An artifact retentionExpiresAt is also its timestamp and expires it at age zero.
    case "artifact":
      return 0;
    default: {
      const category = RETENTION_CLASS_BY_ITEM_TYPE[itemType as PlatformRecord["itemType"]];
      return category ? policy[category] * DAY_MILLISECONDS : undefined;
    }
  }
}

export function isActive(record: PlatformRecord) {
  const data = record.data as Readonly<Record<string, unknown>>;
  if (record.itemType === "message-publication") {
    return record.data.status === "reserved" || record.data.status === "committed";
  }
  if (record.itemType === "trace") {
    return record.data.status === "open";
  }
  if (record.itemType === "evaluation-run" || record.itemType === "release-comparison") {
    return record.data.status === "queued" || record.data.status === "running";
  }
  if (record.itemType === "run") {
    return ["queued", "running", "waiting-for-approval", "waiting-for-tool"].includes(
      String(data.status),
    );
  }
  if (record.itemType === "workflow-execution") {
    return !["canceled", "completed", "failed"].includes(record.data.status);
  }
  if (record.itemType === "governance-operation") {
    return record.data.status === "pending" || record.data.status === "running";
  }
  if (record.itemType === "channel-delivery") {
    return record.data.status === "queued" || record.data.status === "sending";
  }
  if (record.itemType === "slack-agent-stream" || record.itemType === "teams-agent-stream") {
    return (
      record.data.status === "starting" ||
      record.data.status === "streaming" ||
      record.data.status === "paused" ||
      (record.data.status === "failed" && !record.data.fallbackAllowed) ||
      record.data.fallbackDeliveryId !== undefined
    );
  }
  if (record.itemType === "command") {
    return record.data.status === "accepted" || record.data.status === "running";
  }
  if (record.itemType === "webhook-delivery") {
    return (
      record.data.status === "pending" ||
      record.data.status === "retrying" ||
      record.data.status === "sending"
    );
  }
  if (record.itemType === "inbox-message") {
    return (
      record.data.status === "queued" ||
      record.data.status === "scheduled" ||
      record.data.status === "sending"
    );
  }
  if (record.itemType === "inbox-draft") {
    return (
      record.data.status === "approved" ||
      record.data.status === "pending_approval" ||
      record.data.status === "queued" ||
      record.data.status === "scheduled"
    );
  }
  if (
    record.itemType === "brain-index-job" ||
    record.itemType === "brain-sync-job" ||
    record.itemType === "image-job" ||
    record.itemType === "memory-flush" ||
    record.itemType === "memory-index-job" ||
    record.itemType === "pdf-job"
  ) {
    return record.data.status === "queued" || record.data.status === "running";
  }
  if (record.itemType === "brain-content-cleanup") {
    return record.data.status === "pending" || record.data.status === "deleting";
  }
  if (record.itemType === "memory-recall-attempt") {
    return record.data.status === "running";
  }
  if (record.itemType === "brain-query-attempt") {
    return record.data.status === "running";
  }
  if (record.itemType === "provider-mutation-claim") {
    return record.data.status === "active" || record.data.status === "unknown";
  }
  if (record.itemType === "sandbox-lease") {
    return record.data.status !== "destroyed" && record.data.status !== "error";
  }
  return record.itemType === "artifact" && data.status === "pending";
}
