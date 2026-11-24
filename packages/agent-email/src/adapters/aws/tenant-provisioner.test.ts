import { describe, expect, it } from "bun:test";
import type { AgentEmailProviderTenantRecord } from "../../core/index.ts";
import {
  agentEmailSesConfigurationSetArn,
  agentEmailSesIdentityArn,
  deleteAgentEmailSesTenant,
  reconcileAgentEmailSesTenant,
  syncAgentEmailSesSuppression,
  type AgentEmailSesTenantOperations,
} from "./tenant-provisioner.ts";

const record: AgentEmailProviderTenantRecord = {
  createdAt: "2026-07-20T00:00:00.000Z",
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  provider: "ses",
  providerMetadata: {},
  providerName: "agent-inboxes-example",
  region: "us-east-1",
  sendingStatus: "provisioning",
  suppressedReasons: ["bounce", "complaint"],
  suppressionScope: "tenant",
  updatedAt: "2026-07-20T00:00:00.000Z",
};

function operations(): AgentEmailSesTenantOperations {
  return {
    associateResource: async () => {},
    createTenant: async () => {},
    deleteSuppression: async () => {},
    deleteTenant: async () => {},
    dissociateResource: async () => {},
    getReputation: async () => ({}),
    getTenant: async () => ({
      Tenant: {
        SuppressionAttributes: {
          SuppressedReasons: ["BOUNCE", "COMPLAINT"],
          SuppressionScope: "TENANT",
        },
        Tags: [
          { Key: "agent-inboxes:organization-id", Value: record.organizationId },
          { Key: "agent-inboxes:resource-id", Value: record.id },
        ],
        TenantArn: "arn:aws:ses:us-east-1:123456789012:tenant/example",
        TenantId: "tenant-id",
        TenantName: record.providerName,
      },
    }),
    listResources: async () => [],
    putSuppression: async () => {},
    putSuppressionAttributes: async () => {},
    updateCustomerManagedStatus: async () => {},
  };
}

describe("agent email SES tenant reconciliation", () => {
  it("builds partition-aware SES resource ARNs", () => {
    expect(
      agentEmailSesIdentityArn("us-gov-east-1", "123456789012", "customer.example", "aws-us-gov"),
    ).toBe("arn:aws-us-gov:ses:us-gov-east-1:123456789012:identity/customer.example");
    expect(
      agentEmailSesConfigurationSetArn(
        "us-gov-east-1",
        "123456789012",
        "agent-email",
        "aws-us-gov",
      ),
    ).toBe("arn:aws-us-gov:ses:us-gov-east-1:123456789012:configuration-set/agent-email");
  });

  it("remains non-sendable until SES confirms enabled", async () => {
    const reconciled = await reconcileAgentEmailSesTenant(
      record,
      { localSendingStatus: "active", resourceArns: [] },
      { now: () => new Date("2026-07-20T00:01:00.000Z"), operations: operations() },
    );
    expect(reconciled.sendingStatus).toBe("provisioning");
  });

  it("stays disabled locally while provider state converges", async () => {
    const reconciled = await reconcileAgentEmailSesTenant(
      record,
      { localSendingStatus: "paused", resourceArns: [] },
      { now: () => new Date("2026-07-20T00:01:00.000Z"), operations: operations() },
    );
    expect(reconciled.sendingStatus).toBe("disabled");
  });

  it("requests reinstatement for a forced active reputation override", async () => {
    const statuses: string[] = [];
    await reconcileAgentEmailSesTenant(
      {
        ...record,
        providerMetadata: { customerStatusUpdateRequested: true },
      },
      { localSendingStatus: "active", resourceArns: [] },
      {
        operations: {
          ...operations(),
          updateCustomerManagedStatus: async (_tenantArn, status) => {
            statuses.push(status);
          },
        },
      },
    );

    expect(statuses).toEqual(["REINSTATED"]);
  });

  it("preserves an active SES reinstatement on later reconciliation", async () => {
    const statuses: string[] = [];
    await reconcileAgentEmailSesTenant(
      record,
      { localSendingStatus: "active", resourceArns: [] },
      {
        operations: {
          ...operations(),
          getReputation: async () => ({
            ReputationEntity: {
              CustomerManagedStatus: { Status: "REINSTATED" },
              SendingStatusAggregate: "REINSTATED",
            },
          }),
          updateCustomerManagedStatus: async (_tenantArn, status) => {
            statuses.push(status);
          },
        },
      },
    );

    expect(statuses).toEqual([]);
  });

  it("preserves unrelated tenant resources and applies only explicit removals", async () => {
    const associated: string[] = [];
    const dissociated: string[] = [];
    const removeArn = "arn:aws:ses:us-east-1:123456789012:configuration-set/remove";
    const retainedArn = "arn:aws:ses:us-east-1:123456789012:identity/retained.example";
    const addedArn = "arn:aws:ses:us-east-1:123456789012:identity/added.example";
    const reconciled = await reconcileAgentEmailSesTenant(
      {
        ...record,
        providerMetadata: { managedResourceArns: [removeArn, retainedArn] },
      },
      {
        localSendingStatus: "active",
        removeResourceArns: [removeArn],
        resourceArns: [addedArn],
      },
      {
        operations: {
          ...operations(),
          associateResource: async (_tenantName, resourceArn) => {
            associated.push(resourceArn);
          },
          dissociateResource: async (_tenantName, resourceArn) => {
            dissociated.push(resourceArn);
          },
          listResources: async () => [{ ResourceArn: removeArn }, { ResourceArn: retainedArn }],
        },
      },
    );

    expect(associated).toEqual([addedArn]);
    expect(dissociated).toEqual([removeArn]);
    expect(reconciled.providerMetadata.managedResourceArns).toEqual([addedArn, retainedArn]);
  });

  it("synchronizes tenant-scoped suppression destinations", async () => {
    const puts: (readonly [string, string, string | undefined])[] = [];
    const deletes: (readonly [string, string])[] = [];
    const adapter: AgentEmailSesTenantOperations = {
      ...operations(),
      deleteSuppression: async (tenantName, address) => {
        deletes.push([tenantName, address]);
      },
      putSuppression: async (tenantName, address, reason) => {
        puts.push([tenantName, address, reason]);
      },
    };

    await syncAgentEmailSesSuppression(
      {
        address: "bounce@example.net",
        reason: "bounce",
        removed: false,
        tenantName: record.providerName,
      },
      { operations: adapter, region: record.region },
    );
    await syncAgentEmailSesSuppression(
      {
        address: "complaint@example.net",
        reason: "complaint",
        removed: true,
        tenantName: record.providerName,
      },
      { operations: adapter, region: record.region },
    );

    expect(puts).toEqual([[record.providerName, "bounce@example.net", "BOUNCE"]]);
    expect(deletes).toEqual([[record.providerName, "complaint@example.net"]]);
  });

  it("verifies tenant ownership before deletion", async () => {
    let deleted = false;
    const adapter = operations();
    const foreign: AgentEmailSesTenantOperations = {
      ...adapter,
      deleteTenant: async () => {
        deleted = true;
      },
      getTenant: async () => ({
        Tenant: {
          Tags: [{ Key: "agent-inboxes:organization-id", Value: "another-organization" }],
          TenantArn: "arn:aws:ses:us-east-1:123456789012:tenant/foreign",
          TenantId: "foreign-id",
          TenantName: record.providerName,
        },
      }),
    };

    expect(deleteAgentEmailSesTenant(record, { operations: foreign })).rejects.toThrow(
      "owned by another organization",
    );
    expect(deleted).toBe(false);
  });

  it("treats an already missing tenant as deleted", async () => {
    const missing: AgentEmailSesTenantOperations = {
      ...operations(),
      getTenant: async () => {
        const cause = new Error("missing");
        cause.name = "NotFoundException";
        throw cause;
      },
    };

    expect(deleteAgentEmailSesTenant(record, { operations: missing })).resolves.toBeUndefined();
  });
});
