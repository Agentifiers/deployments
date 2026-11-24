import { budgetScopeIndexPartition } from "./budget-record-keys.ts";
import { key } from "./keys.ts";
import { governanceSecondaryKeys } from "./record-key-governance.ts";
import {
  memorySearchControlSecondaryKeys,
  memorySearchExecutionSecondaryKeys,
} from "./memory-search-record-keys.ts";
import { field, requiredField, stableShard, type KeyableRecord } from "./record-key-fields.ts";
import type { LogicalTableName } from "./record-keys.ts";
import { scopeTargetOfRecord } from "./usage-scope.ts";

const executionQueueTypes = new Set([
  "brain-content-cleanup",
  "brain-erasure-job",
  "brain-index-job",
  "brain-sync-job",
  "channel-delivery",
  "image-job",
  "memory-flush",
  "memory-index-job",
  "pdf-job",
  "run",
]);

export const EXECUTION_QUEUE_SHARD_COUNT = 16;
export const EVENT_DELIVERY_SHARD_COUNT = 16;
export const IDENTITY_EMAIL_DISPATCH_SHARD_COUNT = 16;
export const MONITOR_SWEEP_SHARD_COUNT = 16;

/** Install-wide index of operator access grants, ordered by state and then expiry. */
export const OPERATOR_ACCESS_INDEX_PARTITION = key("GLOBAL", "ORGANIZATION-OPERATOR-ACCESS");

function operatorAccessIndexSort(record: KeyableRecord) {
  const state = record.data.state as Readonly<Record<string, unknown>> | undefined;
  return key(
    requiredField({ data: state ?? {}, itemType: record.itemType }, "kind"),
    requiredField(record, "expiresAt"),
    requiredField(record, "organizationId"),
    requiredField(record, "principalId"),
  );
}

function sortStatus(record: KeyableRecord) {
  return field(record.data, "status") ?? "all";
}

function sortTime(record: KeyableRecord) {
  return (
    field(record.data, "nextDueAt") ??
    field(record.data, "updatedAt") ??
    field(record.data, "occurredAt") ??
    field(record.data, "createdAt") ??
    field(record.data, "bucket") ??
    field(record.data, "periodStart") ??
    "0"
  );
}

function brainGrantTarget(record: KeyableRecord) {
  const targetType = field(record.data, "targetType");
  switch (targetType) {
    case "agent-definition":
      return ["AGENT", requiredField(record, "agentDefinitionId")];
    case "organization-role":
      return ["ROLE", requiredField(record, "organizationRole")];
    case "principal":
      return ["PRINCIPAL", requiredField(record, "principalId")];
    case "service-account":
      return ["SERVICE-ACCOUNT", requiredField(record, "serviceAccountId")];
    default:
      return undefined;
  }
}

function brainGraphEndpoint(record: KeyableRecord, name: "from" | "to") {
  const candidate = record.data[name];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError(`Brain edge requires a ${name} endpoint.`);
  }
  const endpoint = candidate as Readonly<Record<string, unknown>>;
  const kind = field(endpoint, "kind");
  const id = field(endpoint, "id");
  if (!kind || !id) throw new TypeError(`Brain edge ${name} endpoint is invalid.`);
  return [kind, id] as const;
}

export function secondaryKeys(
  record: KeyableRecord,
  table: LogicalTableName,
  identity: readonly string[],
) {
  if (record.itemType === "email-tenant") return {};
  if (record.itemType === "email-domain") {
    return {
      gsi1pk: key(
        "ORG",
        requiredField(record, "organizationId"),
        "PROJECT",
        requiredField(record, "projectId"),
        "ENV",
        requiredField(record, "environmentId"),
        "EMAIL-TENANT",
        requiredField(record, "tenantId"),
      ),
      gsi1sk: key("EMAIL-DOMAIN", requiredField(record, "id")),
    };
  }
  const organizationId = field(record.data, "organizationId");
  const environmentId = field(record.data, "environmentId");
  const projectId = field(record.data, "projectId");
  const status = sortStatus(record);
  const time = sortTime(record);
  const resourceTime =
    record.itemType === "inbox-message" && status === "scheduled"
      ? requiredField(record, "scheduledAt")
      : time;
  const resourceSort = key(record.itemType.toUpperCase(), status, resourceTime, ...identity);
  const memorySecondary =
    table === "control"
      ? memorySearchControlSecondaryKeys(record, identity, resourceSort, field, requiredField)
      : table === "execution"
        ? memorySearchExecutionSecondaryKeys(
            record,
            identity,
            resourceSort,
            status,
            field,
            requiredField,
          )
        : {};
  const governanceSecondary = governanceSecondaryKeys(record, table, identity);

  switch (table) {
    case "identity":
      return record.itemType === "identity-session"
        ? {
            gsi1pk: key("PRINCIPAL", requiredField(record, "principalId"), "IDENTITY-SESSIONS"),
            gsi1sk: key(
              "IDENTITY-SESSION",
              status,
              requiredField(record, "createdAt"),
              requiredField(record, "id"),
            ),
          }
        : record.itemType === "oauth-refresh-family"
          ? {
              gsi1pk: key(
                "PRINCIPAL",
                requiredField(record, "principalId"),
                "OAUTH-REFRESH-FAMILIES",
              ),
              gsi1sk: key(
                "OAUTH-REFRESH-FAMILY",
                status,
                requiredField(record, "createdAt"),
                requiredField(record, "id"),
              ),
            }
          : {};
    case "control": {
      const grantTarget = record.itemType === "brain-grant" ? brainGrantTarget(record) : undefined;
      return {
        ...governanceSecondary,
        ...(record.itemType === "organization"
          ? {
              gsi1pk: key("GLOBAL", "ORGANIZATIONS"),
              gsi1sk: resourceSort,
            }
          : record.itemType === "brain-upload-ticket" && organizationId
            ? {
                gsi1pk: key(
                  "QUEUE",
                  "BRAIN-UPLOAD-TICKET",
                  status,
                  stableShard(identity, EXECUTION_QUEUE_SHARD_COUNT),
                ),
                gsi1sk: key("00000000", requiredField(record, "expiresAt"), ...identity),
              }
            : grantTarget && organizationId
              ? {
                  gsi1pk: key("ORG", organizationId, ...grantTarget, "BRAIN-GRANTS"),
                  gsi1sk: key("BRAIN-GRANT", status, requiredField(record, "brainId"), ...identity),
                }
              : record.itemType === "brain-deployment-mount" && organizationId
                ? {
                    gsi1pk: key(
                      "ORG",
                      organizationId,
                      "AGENT-DEPLOYMENT",
                      requiredField(record, "agentDeploymentId"),
                      "BRAIN-MOUNTS",
                    ),
                    gsi1sk: key(
                      "BRAIN-DEPLOYMENT-MOUNT",
                      status,
                      requiredField(record, "brainId"),
                      ...identity,
                    ),
                  }
                : record.itemType === "brain-index-state" && organizationId
                  ? {
                      gsi1pk: key(
                        "ORG",
                        organizationId,
                        "BRAIN",
                        requiredField(record, "brainId"),
                        "INDEX-STATES",
                      ),
                      gsi1sk: resourceSort,
                    }
                  : record.itemType === "brain-edge" && organizationId
                    ? {
                        gsi1pk: key(
                          "ORG",
                          organizationId,
                          "BRAIN",
                          requiredField(record, "brainId"),
                          "GRAPH",
                          ...brainGraphEndpoint(record, "from"),
                          "OUTGOING",
                        ),
                        gsi1sk: key(
                          requiredField(record, "relation"),
                          ...brainGraphEndpoint(record, "to"),
                          ...identity,
                        ),
                      }
                    : memorySecondary.gsi1pk && memorySecondary.gsi1sk
                      ? {
                          gsi1pk: memorySecondary.gsi1pk,
                          gsi1sk: memorySecondary.gsi1sk,
                        }
                      : record.itemType === "inbox-binding" && environmentId
                        ? {
                            gsi1pk: key(
                              "ENV",
                              environmentId,
                              "INBOX",
                              requiredField(record, "inboxId"),
                              "BINDINGS",
                            ),
                            gsi1sk: key(
                              "INBOX-BINDING",
                              status,
                              requiredField(record, "bindingType"),
                              time,
                              ...identity,
                            ),
                          }
                        : record.itemType === "memory-space-grant" && environmentId
                          ? {
                              gsi1pk: key(
                                "ENV",
                                environmentId,
                                "AGENT",
                                requiredField(record, "agentDefinitionId"),
                                "MEMORY-SPACE-GRANTS",
                              ),
                              gsi1sk: key(
                                "MEMORY-SPACE-GRANT",
                                field(record.data, "revokedAt") ? "revoked" : "active",
                                field(record.data, "workspaceId") ?? "environment",
                                requiredField(record, "memorySpaceId"),
                                ...identity,
                              ),
                            }
                          : organizationId &&
                              record.itemType !== "governance-tenant-record" &&
                              record.itemType !== "organization-gate-lane"
                            ? {
                                gsi1pk: key("ORG", organizationId),
                                gsi1sk: resourceSort,
                              }
                            : {}),
        ...(record.itemType === "monitor" && status !== "archived"
          ? {
              gsi1pk: key("MONITOR-SWEEP", stableShard(identity, MONITOR_SWEEP_SHARD_COUNT)),
              gsi1sk: key("MONITOR", requiredField(record, "organizationId"), ...identity),
            }
          : {}),
        ...(memorySecondary.gsi2pk && memorySecondary.gsi2sk
          ? {
              gsi2pk: memorySecondary.gsi2pk,
              gsi2sk: memorySecondary.gsi2sk,
            }
          : (record.itemType === "brain-index-state" ||
                record.itemType === "brain-provider-mutation-claim") &&
              field(record.data, "targetId")
            ? {
                gsi2pk: key("BRAIN-SEARCH-TARGET", requiredField(record, "targetId")),
                gsi2sk: resourceSort,
              }
            : record.itemType === "brain-edge" && organizationId
              ? {
                  gsi2pk: key(
                    "ORG",
                    organizationId,
                    "BRAIN",
                    requiredField(record, "brainId"),
                    "GRAPH",
                    ...brainGraphEndpoint(record, "to"),
                    "INCOMING",
                  ),
                  gsi2sk: key(
                    requiredField(record, "relation"),
                    ...brainGraphEndpoint(record, "from"),
                    ...identity,
                  ),
                }
              : record.itemType === "organization-operator-access"
                ? {
                    gsi2pk: OPERATOR_ACCESS_INDEX_PARTITION,
                    gsi2sk: operatorAccessIndexSort(record),
                  }
                : record.itemType === "organization-member"
                  ? {
                      gsi2pk: key("PRINCIPAL", requiredField(record, "principalId")),
                      gsi2sk: resourceSort,
                    }
                  : record.itemType === "environment" && projectId
                    ? {
                        gsi2pk: key("PROJECT", projectId),
                        gsi2sk: resourceSort,
                      }
                    : environmentId
                      ? { gsi2pk: key("ENV", environmentId), gsi2sk: resourceSort }
                      : {}),
      };
    }
    case "execution":
      if (record.itemType === "score-result") {
        return {
          ...governanceSecondary,
          gsi1pk: key(
            "ORG",
            requiredField(record, "organizationId"),
            "SCORE-DEFINITION",
            requiredField(record, "scoreDefinitionId"),
            "SCORE-RESULTS",
          ),
          gsi1sk: key(
            requiredField(record, "createdAt"),
            requiredField(record, "traceId"),
            ...identity,
          ),
          gsi2pk: key("ENV", requiredField(record, "environmentId")),
          gsi2sk: resourceSort,
        };
      }
      if (record.itemType === "evaluation-run" || record.itemType === "release-comparison") {
        // Hash-derived IDs carry no time order, so history lists sort by creation time.
        return {
          ...governanceSecondary,
          gsi1pk: key(
            "ORG",
            requiredField(record, "organizationId"),
            "ENV",
            requiredField(record, "environmentId"),
            record.itemType === "evaluation-run" ? "EVALUATION-RUNS" : "RELEASE-COMPARISONS",
          ),
          gsi1sk: key(requiredField(record, "createdAt"), ...identity),
          gsi2pk: key("ENV", requiredField(record, "environmentId")),
          gsi2sk: resourceSort,
        };
      }
      return {
        ...governanceSecondary,
        ...(record.itemType === "brain-query-attempt" || record.itemType === "brain-retrieval"
          ? {
              gsi1pk: key(
                "ORG",
                requiredField(record, "organizationId"),
                "BRAIN-TELEMETRY",
                record.itemType.toUpperCase(),
              ),
              gsi1sk: key(requiredField(record, "createdAt"), ...identity),
            }
          : record.itemType === "brain-review-item" && organizationId
            ? {
                gsi1pk: key(
                  "ORG",
                  organizationId,
                  "BRAIN",
                  requiredField(record, "brainId"),
                  "REVIEWS",
                ),
                gsi1sk: resourceSort,
              }
            : record.itemType === "artifact" && organizationId && field(record.data, "runId")
              ? {
                  gsi1pk: key(
                    "ORG",
                    organizationId,
                    "RUN",
                    requiredField(record, "runId"),
                    "ARTIFACTS",
                  ),
                  gsi1sk: resourceSort,
                }
              : memorySecondary.gsi1pk && memorySecondary.gsi1sk
                ? {
                    gsi1pk: memorySecondary.gsi1pk,
                    gsi1sk: memorySecondary.gsi1sk,
                  }
                : record.itemType === "schedule-fire" &&
                    organizationId &&
                    field(record.data, "firedAt") &&
                    field(record.data, "id")
                  ? {
                      gsi1pk: key(
                        "ORG",
                        organizationId,
                        "SCHEDULE",
                        requiredField(record, "scheduleId"),
                        "FIRES",
                      ),
                      gsi1sk: key(field(record.data, "firedAt")!, field(record.data, "id")!),
                    }
                  : record.itemType === "heartbeat-run" &&
                      organizationId &&
                      field(record.data, "createdAt") &&
                      field(record.data, "id")
                    ? {
                        gsi1pk: key(
                          "ORG",
                          organizationId,
                          "HEARTBEAT",
                          requiredField(record, "heartbeatId"),
                          "FIRES",
                        ),
                        gsi1sk: key(field(record.data, "createdAt")!, field(record.data, "id")!),
                      }
                    : record.itemType === "inbox-content-cleanup" &&
                        organizationId &&
                        projectId &&
                        environmentId &&
                        status === "pending"
                      ? {
                          gsi1pk: key(
                            "INBOX-CONTENT-CLEANUP",
                            organizationId,
                            projectId,
                            environmentId,
                          ),
                          gsi1sk: key(requiredField(record, "createdAt"), ...identity),
                        }
                      : record.itemType === "inbox-attachment" && organizationId
                        ? {
                            gsi1pk: key(
                              "ORG",
                              organizationId,
                              "INBOX-ATTACHMENT",
                              requiredField(record, "id"),
                            ),
                            gsi1sk: key("INBOX-ATTACHMENT", requiredField(record, "id")),
                          }
                        : record.itemType === "memory-recall-attempt" ||
                            record.itemType === "memory-retrieval"
                          ? {
                              gsi1pk: key(
                                "ENV",
                                requiredField(record, "environmentId"),
                                "ORG",
                                requiredField(record, "organizationId"),
                                "PROJECT",
                                requiredField(record, "projectId"),
                                "MEMORY-TELEMETRY",
                                record.itemType,
                              ),
                              gsi1sk: key(requiredField(record, "createdAt"), ...identity),
                              gsi2pk: key(
                                "ENV",
                                requiredField(record, "environmentId"),
                                "ORG",
                                requiredField(record, "organizationId"),
                                "PROJECT",
                                requiredField(record, "projectId"),
                                "WORKSPACE",
                                field(record.data, "workspaceId") ?? "environment",
                                "MEMORY-TELEMETRY",
                                record.itemType,
                              ),
                              gsi2sk: key(requiredField(record, "createdAt"), ...identity),
                            }
                          : record.itemType === "inbox-message" &&
                              environmentId &&
                              field(record.data, "rawRetentionExpiresAt") &&
                              !field(record.data, "rawPurgedAt") &&
                              record.data.rawReference
                            ? {
                                gsi1pk: key(
                                  "INBOX-RAW-RETENTION",
                                  requiredField(record, "organizationId"),
                                  requiredField(record, "projectId"),
                                  environmentId,
                                ),
                                gsi1sk: key(
                                  requiredField(record, "rawRetentionExpiresAt"),
                                  ...identity,
                                ),
                              }
                            : executionQueueTypes.has(record.itemType) &&
                                (record.itemType !== "memory-index-job" ||
                                  field(record.data, "nextDueAt")) &&
                                // A terminally failed Brain index job has no due time and leaves the queue.
                                (record.itemType !== "brain-index-job" ||
                                  status !== "failed" ||
                                  field(record.data, "nextDueAt"))
                              ? {
                                  gsi1pk: key(
                                    "QUEUE",
                                    record.itemType.toUpperCase(),
                                    status,
                                    stableShard(identity, EXECUTION_QUEUE_SHARD_COUNT),
                                  ),
                                  gsi1sk: key(
                                    String(field(record.data, "priority") ?? "0").padStart(8, "0"),
                                    time,
                                    ...identity,
                                  ),
                                }
                              : {}),
        ...(memorySecondary.gsi2pk && memorySecondary.gsi2sk
          ? {
              gsi2pk: memorySecondary.gsi2pk,
              gsi2sk: memorySecondary.gsi2sk,
            }
          : (record.itemType === "run" || record.itemType === "thread") &&
              environmentId &&
              field(record.data, "executionBindingId")
            ? {
                gsi2pk: key(
                  "ENV",
                  environmentId,
                  "EXECUTION-BINDING",
                  requiredField(record, "executionBindingId"),
                ),
                gsi2sk: resourceSort,
              }
            : record.itemType === "run" && environmentId
              ? {
                  gsi2pk: key(
                    "ENV",
                    environmentId,
                    "AGENT-DEPLOYMENT",
                    requiredField(record, "agentDeploymentId"),
                  ),
                  gsi2sk: resourceSort,
                }
              : record.itemType === "artifact" && environmentId
                ? // Creation order, so a download link or a retention change does not move an artifact.
                  {
                    gsi2pk: key("ENV", environmentId),
                    gsi2sk: key("ARTIFACT", requiredField(record, "createdAt"), ...identity),
                  }
                : environmentId &&
                    record.itemType !== "generation-reasoning" &&
                    record.itemType !== "runtime-log-batch" &&
                    record.itemType !== "memory-recall-attempt" &&
                    record.itemType !== "memory-retrieval" &&
                    record.itemType !== "runtime-lease"
                  ? { gsi2pk: key("ENV", environmentId), gsi2sk: resourceSort }
                  : {}),
      };
    case "events": {
      return {
        ...governanceSecondary,
        ...(record.itemType === "semantic-event"
          ? {
              gsi1pk: key(
                "AGGREGATE",
                requiredField(record, "aggregateType"),
                requiredField(record, "aggregateId"),
              ),
              gsi1sk: key(
                "VERSION",
                requiredField(record, "aggregateVersion").padStart(16, "0"),
                requiredField(record, "eventId"),
              ),
            }
          : record.itemType === "identity-security-event"
            ? {
                gsi1pk: key(
                  "PRINCIPAL",
                  requiredField(record, "principalId"),
                  "IDENTITY-SECURITY-EVENTS",
                ),
                gsi1sk: key(requiredField(record, "occurredAt"), requiredField(record, "eventId")),
              }
            : record.itemType === "webhook-delivery"
              ? {
                  gsi1pk: key(
                    "WEBHOOK-ENDPOINT",
                    requiredField(record, "webhookEndpointId"),
                    "DELIVERIES",
                  ),
                  gsi1sk: key("WEBHOOK-DELIVERY", requiredField(record, "createdAt"), ...identity),
                }
              : record.itemType === "monitor-incident"
                ? {
                    gsi1pk: key(
                      "ORG",
                      requiredField(record, "organizationId"),
                      "MONITOR-INCIDENTS",
                    ),
                    gsi1sk: key(requiredField(record, "openedAt"), ...identity),
                  }
                : {}),
        ...(record.itemType === "monitor-incident" && environmentId
          ? {
              gsi2pk: key("ENV", environmentId, "MONITOR-INCIDENTS"),
              gsi2sk: key(requiredField(record, "openedAt"), ...identity),
            }
          : {}),
        ...(record.itemType === "replay-request"
          ? {
              gsi2pk: key("DELIVERY", status, stableShard(identity, EVENT_DELIVERY_SHARD_COUNT)),
              gsi2sk: key(time, ...identity),
            }
          : {}),
      };
    }
    case "identity-email-outbox":
      return record.itemType === "identity-email-delivery" && sortStatus(record) === "pending"
        ? {
            gsi1pk: key("IDENTITY-EMAIL-PENDING", requiredField(record, "dispatchShard")),
            gsi1sk: key(requiredField(record, "nextDispatchAt"), requiredField(record, "id")),
          }
        : {};
    case "usage": {
      if (record.itemType === "budget") {
        return {
          gsi1pk: budgetScopeIndexPartition(
            requiredField(record, "organizationId"),
            scopeTargetOfRecord(record),
          ),
          gsi1sk: key("BUDGET", status, ...identity),
        };
      }
      // Read only through their exact base partitions; no metric projection. Attributed
      // counters would otherwise share their metric's partition with the environment counters.
      if (
        record.itemType === "budget-period" ||
        record.itemType === "scope-spend-shard" ||
        record.itemType === "attributed-usage-counter-shard"
      ) {
        return {};
      }
      const metric =
        field(record.data, "metric") ?? field(record.data, "source") ?? record.itemType;
      const bucket = field(record.data, "bucket") ?? time;
      return {
        ...governanceSecondary,
        ...(organizationId
          ? {
              gsi1pk: key("ORG", organizationId, "METRIC", metric),
              gsi1sk: key(bucket, ...identity),
            }
          : {}),
        ...(environmentId
          ? {
              gsi2pk: key("ENV", environmentId, "METRIC", metric),
              gsi2sk: key(bucket, ...identity),
            }
          : {}),
      };
    }
  }
}
