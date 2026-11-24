import { scopeSpendPartition } from "./budget-record-keys.ts";
import { identityFederationPrimaryKeys } from "./identity-federation/record-keys.ts";
import { key } from "./keys.ts";
import { memorySearchPrimaryKeys } from "./memory-search-record-keys.ts";
import { field, requiredField, type KeyableRecord } from "./record-key-fields.ts";
import { governanceInventoryPartition } from "./record-key-governance.ts";
import { identityHash } from "./record-key-identity.ts";
import { conversationErasurePrimaryKeys } from "./thread-erasure/record-keys.ts";
import { scopeTargetOfRecord } from "./usage-scope.ts";

const aggregatePartitionFieldByItemType: Readonly<Record<string, string>> = {
  "agent-definition-release-index": "agentDefinitionId",
  "agent-release-control": "agentDefinitionId",
  "agent-release-hosted-code-tool": "agentReleaseId",
  "execution-binding-hosted-code-tool": "executionBindingId",
  "app-domain": "appId",
  "app-grant": "appId",
  "app-release": "appId",
  approval: "runId",
  "agent-run-plan": "runId",
  "budget-period": "budgetId",
  "brain-deployment-mount": "brainId",
  "brain-content-cleanup": "brainId",
  "brain-duplicate-pass": "brainId",
  "brain-erasure-job": "brainId",
  "brain-content-staging": "documentVersionId",
  "brain-edge": "brainId",
  "brain-entity": "brainId",
  "brain-document": "brainId",
  "brain-document-rendition": "documentVersionId",
  "brain-document-version": "documentId",
  "brain-grant": "brainId",
  "brain-index-job": "documentId",
  "brain-index-state": "documentId",
  "brain-provider-mutation-claim": "documentId",
  "brain-retrieval": "queryAttemptId",
  "brain-review-item": "brainId",
  "brain-sync-job": "brainId",
  "brain-source": "brainId",
  "brain-source-item-claim": "sourceId",
  "brain-source-order-claim": "documentId",
  "brain-source-revision-claim": "sourceId",
  "brain-upload-lease": "brainId",
  "brain-upload-ticket": "brainId",
  "channel-delivery": "runId",
  "channel-delivery-lookup": "runId",
  "channel-ingress-burst": "routeId",
  "channel-ingress-burst-head": "routeId",
  "channel-ingress-source-claim": "routeId",
  "dataset-case": "datasetId",
  "evaluation-case-run": "evaluationRunId",
  "channel-ingress-source": "routeId",
  "conversation-checkpoint": "threadId",
  "generation-reasoning": "runId",
  heartbeat: "agentDeploymentId",
  "heartbeat-run": "heartbeatId",
  "inbox-attachment": "inboxMessageId",
  "inbox-content-cleanup": "resourceId",
  "inbox-draft": "inboxId",
  "inbox-draft-created-index": "inboxId",
  "inbox-message-created-index": "inboxId",
  "inbox-message-thread-index": "threadId",
  "inbox-message-thread-alias": "inboxId",
  "inbox-message": "inboxId",
  "inbox-thread-created-index": "inboxId",
  "inbox-thread": "inboxId",
  "inbound-thread-route": "sourceId",
  "memory-flush": "runId",
  "memory-index-job": "memoryId",
  "memory-index-state": "memoryId",
  "monitor-incident": "monitorId",
  "monitor-signal": "monitorId",
  "memory-retrieval": "memoryId",
  "memory-review-item": "memoryId",
  message: "threadId",
  "message-publication": "threadId",
  "model-invocation": "runId",
  "pdf-job": "runId",
  "provider-mutation-claim": "runId",
  "rate-limit-counter": "scopeId",
  run: "threadId",
  "run-delegation": "childRunId",
  "run-edge": "parentRunId",
  "run-lookup": "threadId",
  "runtime-log-batch": "runId",
  "score-definition-revision": "scoreDefinitionId",
  "score-result": "traceId",
  "sandbox-workspace": "threadId",
  "schedule-fire": "scheduleId",
  "slack-agent-stream": "runId",
  "teams-agent-stream": "runId",
  "stream-session": "threadId",
  "timeline-event": "runId",
  "tool-call": "runId",
  trace: "traceId",
  annotation: "traceId",
  "workflow-approval": "workflowExecutionId",
  "workflow-step-attempt": "workflowExecutionId",
  "webhook-delivery-attempt": "webhookDeliveryId",
};

export function primaryKeys(record: KeyableRecord, identity: readonly string[]) {
  const memoryKeys = memorySearchPrimaryKeys(record, requiredField);
  if (memoryKeys) return memoryKeys;
  const erasureKeys = conversationErasurePrimaryKeys(record);
  if (erasureKeys) return erasureKeys;
  const federationKeys = identityFederationPrimaryKeys(record);
  if (federationKeys) return federationKeys;
  if (record.itemType === "email-tenant" || record.itemType === "email-domain") {
    return {
      pk: key(
        "ORG",
        requiredField(record, "organizationId"),
        "PROJECT",
        requiredField(record, "projectId"),
        "ENV",
        requiredField(record, "environmentId"),
      ),
      sk: key(record.itemType.toUpperCase(), requiredField(record, "id")),
    };
  }

  if (record.itemType === "unique-claim") {
    return {
      pk: key("UNIQUE", requiredField(record, "namespace")),
      sk: key("VALUE", requiredField(record, "value")),
    };
  }

  if (record.itemType === "governance-tenant-record") {
    const recordTable = requiredField(record, "recordTable");
    const recordPk = requiredField(record, "recordPk");
    const recordSk = requiredField(record, "recordSk");
    return {
      pk: governanceInventoryPartition(
        requiredField(record, "organizationId"),
        recordTable,
        recordPk,
        recordSk,
      ),
      sk: key("RECORD", identityHash([recordTable, recordPk, recordSk].join("\0"))),
    };
  }

  if (record.itemType === "governance-inventory-state") {
    return {
      pk: key("GLOBAL", "GOVERNANCE-INVENTORY"),
      sk: key("STATE", identity[0] as string),
    };
  }

  if (record.itemType === "governance-legacy-record") {
    return {
      pk: key("GLOBAL", "GOVERNANCE-LEGACY", requiredField(record, "kind")),
      sk: key(
        "RECORD",
        identityHash(
          [
            requiredField(record, "recordTable"),
            requiredField(record, "recordPk"),
            requiredField(record, "recordSk"),
          ].join("\0"),
        ),
      ),
    };
  }

  if (record.itemType === "organization") {
    const id = identity[0] as string;
    return { pk: key("ORG", id), sk: key("ORG", id) };
  }

  if (record.itemType === "principal") {
    const id = identity[0] as string;
    return { pk: key("PRINCIPAL", id), sk: key("PRINCIPAL", id) };
  }

  switch (record.itemType) {
    case "principal-credential":
    case "principal-email-change":
    case "principal-mfa-factor":
    case "principal-organization-creations":
    case "principal-security-state":
      return {
        pk: key("PRINCIPAL", requiredField(record, "principalId")),
        sk: key(record.itemType.toUpperCase(), ...identity),
      };
    case "identity-session-locator":
      return {
        pk: key("PRINCIPAL", requiredField(record, "principalId")),
        sk: key("IDENTITY-SESSION-LOCATOR", requiredField(record, "sessionId")),
      };
    case "identity-mfa-challenge":
      return {
        pk: key("IDENTITY-MFA-CHALLENGE", requiredField(record, "tokenHash")),
        sk: key("IDENTITY-MFA-CHALLENGE", requiredField(record, "tokenHash")),
      };
    case "identity-action":
      return {
        pk: key("IDENTITY-ACTION", requiredField(record, "tokenHash")),
        sk: key("IDENTITY-ACTION", requiredField(record, "tokenHash")),
      };
    case "identity-bff-revocation-fence":
      return {
        pk: key("BFF-IDENTITY-FENCE", requiredField(record, "principalId")),
        sk: key("BFF-IDENTITY-FENCE", requiredField(record, "principalId")),
      };
    case "identity-rate-limit":
      return {
        pk: key(
          "IDENTITY-RATE-LIMIT",
          requiredField(record, "limitKey"),
          requiredField(record, "scopeHash"),
          requiredField(record, "window"),
        ),
        sk: key(
          "IDENTITY-RATE-LIMIT",
          requiredField(record, "limitKey"),
          requiredField(record, "scopeHash"),
          requiredField(record, "window"),
        ),
      };
    case "identity-public-email-request":
      return {
        pk: key("IDENTITY-PUBLIC-EMAIL-REQUEST", requiredField(record, "id")),
        sk: key("IDENTITY-PUBLIC-EMAIL-REQUEST", requiredField(record, "id")),
      };
    case "identity-registration":
      return {
        pk: key("IDENTITY-REGISTRATION", requiredField(record, "emailHash")),
        sk: key("IDENTITY-REGISTRATION", requiredField(record, "emailHash")),
      };
    case "identity-email-delivery":
      return {
        pk: key("IDENTITY-EMAIL-DELIVERY", requiredField(record, "id")),
        sk: key("IDENTITY-EMAIL-DELIVERY", requiredField(record, "id")),
      };
    case "identity-security-event":
      return {
        pk: key(
          "IDENTITY-SECURITY-EVENT",
          requiredField(record, "aggregateType"),
          requiredField(record, "aggregateId"),
        ),
        sk: key("IDENTITY-SECURITY-EVENT", ...identity),
      };
    case "identity-session":
      return {
        pk: key("IDENTITY-SESSION", requiredField(record, "tokenHash")),
        sk: key("IDENTITY-SESSION", requiredField(record, "tokenHash")),
      };
    case "oauth-authorization-code":
      return {
        pk: key("OAUTH-AUTHORIZATION-CODE", requiredField(record, "codeHash")),
        sk: key("OAUTH-AUTHORIZATION-CODE", requiredField(record, "codeHash")),
      };
    case "oauth-authorization-request":
      return {
        pk: key("OAUTH-AUTHORIZATION-REQUEST", requiredField(record, "requestHandleHash")),
        sk: key("OAUTH-AUTHORIZATION-REQUEST", requiredField(record, "requestHandleHash")),
      };
    case "oauth-client":
      return {
        pk: key("OAUTH-CLIENT", requiredField(record, "clientId")),
        sk: key("OAUTH-CLIENT", requiredField(record, "clientId")),
      };
    case "oauth-device-grant":
      return {
        pk: key("OAUTH-DEVICE-GRANT", requiredField(record, "deviceCodeHash")),
        sk: key("OAUTH-DEVICE-GRANT", requiredField(record, "deviceCodeHash")),
      };
    case "oauth-refresh-family":
      return {
        pk: key("OAUTH-REFRESH-FAMILY", requiredField(record, "id")),
        sk: key("OAUTH-REFRESH-FAMILY", requiredField(record, "id")),
      };
    case "oauth-refresh-token":
      return {
        pk: key("OAUTH-REFRESH-TOKEN", requiredField(record, "tokenHash")),
        sk: key("OAUTH-REFRESH-TOKEN", requiredField(record, "tokenHash")),
      };
    case "oauth-reauthentication-request":
      return {
        pk: key("OAUTH-REAUTHENTICATION-REQUEST", requiredField(record, "tokenHash")),
        sk: key("OAUTH-REAUTHENTICATION-REQUEST", requiredField(record, "tokenHash")),
      };
    case "web-bff-authorization-transaction":
      return {
        pk: key("WEB-BFF-AUTHORIZATION", requiredField(record, "transactionTokenHash")),
        sk: key("WEB-BFF-AUTHORIZATION", requiredField(record, "transactionTokenHash")),
      };
    case "web-bff-session":
      return {
        pk: key("WEB-BFF-SESSION", requiredField(record, "cookieTokenHash")),
        sk: key("WEB-BFF-SESSION", requiredField(record, "cookieTokenHash")),
      };
    case "app-login-handoff":
    case "app-login-transaction":
    case "app-session":
      return {
        pk: key(record.itemType.toUpperCase(), requiredField(record, "id")),
        sk: key(record.itemType.toUpperCase(), requiredField(record, "id")),
      };
    case "identity-signing-key":
      return {
        pk: key("GLOBAL", "IDENTITY-SIGNING-KEYS"),
        sk: key("IDENTITY-SIGNING-KEY", requiredField(record, "kid")),
      };
  }

  if (record.itemType === "idempotency" && field(record.data, "principalId")) {
    return {
      pk: key("PRINCIPAL", requiredField(record, "principalId"), "IDEMPOTENCY"),
      sk: key("IDEMPOTENCY", ...identity),
    };
  }

  if (record.itemType === "runtime-lease") {
    return {
      pk: key("RUNTIME-LEASE", requiredField(record, "id")),
      sk: key("RUNTIME-LEASE", ...identity),
    };
  }

  if (record.itemType === "rate-limit-counter") {
    return {
      pk: key("SCOPE", requiredField(record, "scopeId")),
      sk: key("RATE-LIMIT-COUNTER", ...identity),
    };
  }

  if (record.itemType === "workflow-step-correlation") {
    return {
      pk: key(
        "ORG",
        requiredField(record, "organizationId"),
        "WORKFLOW-CORRELATION",
        requiredField(record, "externalKind"),
      ),
      sk: key("EXTERNAL", requiredField(record, "externalId")),
    };
  }

  if (record.itemType === "callback-dispatch-evidence") {
    return {
      pk: key("ORG", requiredField(record, "organizationId"), "CALLBACK-DISPATCH-EVIDENCE"),
      sk: key("CALLBACK-DISPATCH-EVIDENCE", requiredField(record, "id")),
    };
  }

  if (record.itemType === "sandbox-lease") {
    return {
      pk: key(
        "ORG",
        requiredField(record, "organizationId"),
        "EXECUTION-TARGET",
        requiredField(record, "executionTargetKind"),
        requiredField(record, "executionTargetId"),
      ),
      sk: key("SANDBOX-LEASE", ...identity),
    };
  }

  if (record.itemType === "monitor" || record.itemType === "monitor-state") {
    // Environment and organization monitors share the organization partition, so one strongly
    // consistent query lists every monitor an event may wake.
    return {
      pk: key("ORG", requiredField(record, "organizationId")),
      sk: key(record.itemType.toUpperCase(), ...identity),
    };
  }

  if (record.itemType === "budget") {
    // Every budget lives in its organization partition so it resolves by id alone; scope lookups
    // use the budget-scope GSI.
    return {
      pk: key("ORG", requiredField(record, "organizationId")),
      sk: key("BUDGET", ...identity),
    };
  }

  if (record.itemType === "scope-spend-shard") {
    return {
      pk: scopeSpendPartition(requiredField(record, "organizationId"), scopeTargetOfRecord(record)),
      sk: key("SCOPE-SPEND-SHARD", ...identity),
    };
  }

  const organizationId = field(record.data, "organizationId");
  const environmentId = field(record.data, "environmentId");
  const projectId = field(record.data, "projectId");
  const partition = organizationId ? ["ORG", organizationId] : [];

  if (
    organizationId &&
    (record.itemType === "inbox" ||
      record.itemType === "memory" ||
      record.itemType === "thread" ||
      record.itemType === "workflow-execution")
  ) {
    partition.push(record.itemType.toUpperCase(), identity[identity.length - 1] as string);
  } else if (record.itemType === "semantic-event") {
    partition.push(
      "AGGREGATE",
      requiredField(record, "aggregateType"),
      requiredField(record, "aggregateId"),
    );
  } else if (record.itemType === "audit-event") {
    // Organization-level audit events share the organization partition; environment activity
    // stays in its environment partition. A project scope alone never selects a partition.
    if (environmentId) partition.push("ENV", environmentId);
  } else if (record.itemType === "brain-query-attempt") {
    // Feedback resolves an attempt from its organization and id alone, so the attempt shares its
    // retrievals' aggregate partition instead of the caller's environment or project.
    partition.push("QUERY-ATTEMPT", requiredField(record, "id"));
  } else {
    const aggregateField = aggregatePartitionFieldByItemType[record.itemType];
    if (aggregateField) {
      const aggregateLabel =
        record.itemType === "run-edge" || record.itemType === "run-delegation"
          ? "RUN"
          : aggregateField
              .replace(/Id$/, "")
              .replace(/([a-z])([A-Z])/g, "$1-$2")
              .toUpperCase();
      partition.push(aggregateLabel, requiredField(record, aggregateField));
    } else if (environmentId) {
      partition.push("ENV", environmentId);
    } else if (projectId) {
      partition.push("PROJECT", projectId);
    } else if (!organizationId) {
      partition.push("GLOBAL", record.itemType);
    }
  }

  return {
    pk: key(...partition),
    sk: key(record.itemType.toUpperCase(), ...identity),
  };
}
