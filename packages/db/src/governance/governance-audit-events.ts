import type { TableNames } from "../client-types.ts";
import type { GovernanceInventoryLayout } from "../governance-inventory-layout.ts";
import {
  makeOrganizationAuditEventRecord,
  type AuditEventRecordValue,
} from "../audit/organization-audit-log.ts";
import { principalAuditActor } from "../tenancy-authorization.ts";
import { tenantDirectoryPut } from "./dynamo-store.ts";
import type { GovernanceOperation, StoredRetentionPolicy } from "./contracts.ts";

/**
 * Organization audit event for a committed retention policy revision. `operatorAccessGrantId`
 * names the operator access a platform administrator made the change under.
 */
export function retentionPolicyAuditEvent(
  policy: StoredRetentionPolicy,
  eventId: string,
  operatorAccessGrantId?: string,
) {
  return makeOrganizationAuditEventRecord({
    action: "retention-policy.updated",
    actor: principalAuditActor(policy.updatedByPrincipalId, operatorAccessGrantId),
    changes: {
      artifacts: policy.artifacts,
      audit: policy.audit,
      events: policy.events,
      messages: policy.messages,
      runs: policy.runs,
      threads: policy.threads,
      version: policy.version,
    },
    eventId,
    occurredAt: policy.updatedAt,
    organizationId: policy.organizationId,
    resourceId: policy.organizationId,
    resourceType: "retention-policy",
  });
}

/** Organization audit event for a newly accepted governance operation request. */
export function governanceOperationRequestedAuditEvent(
  operation: GovernanceOperation,
  eventId: string,
  occurredAt: string,
  operatorAccessGrantId?: string,
) {
  return makeOrganizationAuditEventRecord({
    action: `${operation.kind}.requested`,
    actor: principalAuditActor(operation.requestedByPrincipalId, operatorAccessGrantId),
    changes: { kind: operation.kind, status: operation.status },
    eventId,
    occurredAt,
    organizationId: operation.organizationId,
    resourceId: operation.id,
    resourceType: "governance-operation",
  });
}

/**
 * Append-only audit event put plus its tenant inventory pointer, for raw governance transactions
 * that commit the audited mutation in the same DynamoDB transaction.
 */
export function governanceAuditTransactItems(
  record: AuditEventRecordValue,
  tableNames: TableNames,
  layout: GovernanceInventoryLayout,
) {
  return [
    {
      Put: {
        ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
        Item: record,
        TableName: tableNames.events,
      },
    },
    tenantDirectoryPut(record, tableNames, layout),
  ];
}
