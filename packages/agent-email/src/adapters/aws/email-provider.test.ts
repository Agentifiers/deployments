import { describe, expect, it } from "bun:test";
import type { Tag } from "@aws-sdk/client-sesv2";
import { makeEmailSesSender, type EmailSesMessage } from "./email-send.ts";
import {
  emailSesTenantNames,
  provisionEmailSesTenant,
  readEmailSesTenant,
  type EmailSesTenant,
  type EmailSesConfigurationSetOperations,
} from "./email-tenant.ts";
import type { AgentEmailSesTenantOperations } from "./tenant-provisioner.ts";

const tenant: EmailSesTenant = {
  id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  organizationId: "organization",
  projectId: "project",
  environmentId: "environment",
  region: "us-east-1",
  ...emailSesTenantNames("01ARZ3NDEKTSV4RRFFQ69G5FAV"),
  status: "active",
  sendingStatus: "enabled",
};
const message: EmailSesMessage = {
  from: "Example <sender@example.com>",
  to: ["recipient@example.net"],
  subject: "Private email",
  text: "https://example.com/auth?token=private",
};

function fixture() {
  const mutations: string[] = [];
  let tags: Tag[] = [
    { Key: "agent-inboxes:organization-id", Value: tenant.organizationId },
    { Key: "agent-inboxes:resource-id", Value: tenant.id },
    { Key: "platform-email:managed", Value: "true" },
    { Key: "platform-email:organization-id", Value: tenant.organizationId },
    { Key: "platform-email:project-id", Value: tenant.projectId },
    { Key: "platform-email:environment-id", Value: tenant.environmentId },
    { Key: "platform-email:tenant-id", Value: tenant.id },
  ];
  let status: "DISABLED" | "ENABLED" | "REINSTATED" = "DISABLED";
  let awsDisabled = false;
  const operations: AgentEmailSesTenantOperations = {
    createTenant: async () => {
      mutations.push("createTenant");
    },
    getTenant: async () => ({
      Tenant: {
        Tags: tags,
        TenantId: "provider-id",
        TenantArn: "arn:aws:ses:us-east-1:123456789012:tenant/provider-id",
        SendingStatus: awsDisabled ? "DISABLED" : status,
        SuppressionAttributes: {
          SuppressionScope: "TENANT",
          SuppressedReasons: ["BOUNCE", "COMPLAINT"],
        },
      },
    }),
    getReputation: async () => ({
      ReputationEntity: {
        SendingStatusAggregate: awsDisabled ? "DISABLED" : status,
        CustomerManagedStatus: { Status: status },
        AwsSesManagedStatus: { Status: awsDisabled ? "DISABLED" : "ENABLED" },
      },
    }),
    listResources: async () => [],
    associateResource: async () => {
      mutations.push("associate");
    },
    dissociateResource: async () => {
      mutations.push("dissociate");
    },
    deleteTenant: async () => {
      mutations.push("deleteTenant");
    },
    deleteSuppression: async () => {
      mutations.push("deleteSuppression");
    },
    putSuppression: async () => {
      mutations.push("putSuppression");
    },
    putSuppressionAttributes: async () => {
      mutations.push("tenantSuppression");
    },
    updateCustomerManagedStatus: async (_arn, next) => {
      mutations.push(`status:${next}`);
      status = next;
    },
  };
  const configurationSetOperations: EmailSesConfigurationSetOperations = {
    create: async (input) => {
      mutations.push("createConfigurationSet");
      expect(input.SuppressionOptions?.SuppressedReasons).toEqual(["BOUNCE", "COMPLAINT"]);
    },
    listTags: async () => tags,
    putSuppression: async () => {
      mutations.push("configurationSuppression");
    },
  };
  return {
    mutations,
    operations,
    configurationSetOperations,
    setTags: (next: Tag[]) => {
      tags = next;
    },
    restrictAws: () => {
      awsDisabled = true;
    },
    options: { accountId: "123456789012", operations, configurationSetOperations },
  };
}

describe("generic SES tenant isolation", () => {
  it("keeps missing native tenants discoverable and non-sendable without recreating them", async () => {
    const f = fixture();
    const dependencies = {
      operations: {
        ...f.operations,
        getTenant: async () => {
          throw Object.assign(new Error("Missing native tenant"), { name: "NotFoundException" });
        },
      },
    };
    expect((await readEmailSesTenant(tenant, dependencies)).sendingStatus).toBe("provisioning");
    expect(
      (await readEmailSesTenant({ ...tenant, providerId: "previously-created" }, dependencies))
        .sendingStatus,
    ).toBe("disabled");
    expect(f.mutations).toEqual([]);
  });

  it("propagates unknown native read failures instead of treating them as missing tenants", async () => {
    const f = fixture();
    const failure = new Error("Provider unavailable");
    expect(
      readEmailSesTenant(tenant, {
        operations: {
          ...f.operations,
          getTenant: async () => {
            throw failure;
          },
        },
      }),
    ).rejects.toBe(failure);
    expect(f.mutations).toEqual([]);
  });

  it("reads external pauses without creating resources or reinstating sending", async () => {
    const f = fixture();
    expect((await readEmailSesTenant(tenant, { operations: f.operations })).sendingStatus).toBe(
      "disabled",
    );
    expect(f.mutations).toEqual([]);
  });

  it("does not clear an external pause when provisioning is retried", async () => {
    const f = fixture();
    expect((await provisionEmailSesTenant(tenant, f.options)).sendingStatus).toBe("disabled");
    expect(f.mutations).not.toContain("status:ENABLED");
    expect(f.mutations).not.toContain("status:REINSTATED");
  });

  it("permits explicit admin reinstatement but preserves AWS restrictions", async () => {
    const f = fixture();
    expect(
      (
        await provisionEmailSesTenant(tenant, {
          ...f.options,
          reconcileCustomerManagedStatus: true,
        })
      ).sendingStatus,
    ).toBe("reinstated");
    f.restrictAws();
    expect(
      (
        await provisionEmailSesTenant(tenant, {
          ...f.options,
          reconcileCustomerManagedStatus: true,
        })
      ).sendingStatus,
    ).toBe("disabled");
  });

  it("rejects resources owned by another exact scope before modifying them", async () => {
    const f = fixture();
    f.setTags([
      { Key: "agent-inboxes:organization-id", Value: tenant.organizationId },
      { Key: "agent-inboxes:resource-id", Value: tenant.id },
      { Key: "platform-email:project-id", Value: "another-project" },
    ]);
    expect(readEmailSesTenant(tenant, { operations: f.operations })).rejects.toThrow();
    expect(f.mutations).toEqual([]);
    expect(provisionEmailSesTenant(tenant, f.options)).rejects.toThrow();
    expect(f.mutations).toEqual(["createConfigurationSet"]);
  });

  it("rejects caller-chosen shared resource names", async () => {
    const f = fixture();
    expect(
      provisionEmailSesTenant({ ...tenant, configurationSetName: "shared" }, f.options),
    ).rejects.toThrow();
    expect(f.mutations).toEqual([]);
  });
});

describe("synchronous SES acceptance", () => {
  it("uses the persisted tenant and configuration set and returns genuine acceptance", async () => {
    const events: string[] = [];
    const send = makeEmailSesSender({
      readTenant: async (input) => {
        events.push("read");
        return input;
      },
      send: async (region, input) => {
        events.push("send");
        expect(region).toBe(tenant.region);
        expect(input.TenantName).toBe(tenant.providerName);
        expect(input.ConfigurationSetName).toBe(tenant.configurationSetName);
        return { $metadata: {}, MessageId: "accepted-id" };
      },
    });
    expect(await send(tenant, message)).toEqual({ providerMessageId: "accepted-id" });
    expect(events).toEqual(["read", "send"]);
  });

  it("fails closed before sending when native status is disabled, unknown, or unreadable", async () => {
    let sends = 0;
    for (const sendingStatus of ["disabled", "provisioning"] as const) {
      const send = makeEmailSesSender({
        readTenant: async () => ({ ...tenant, sendingStatus }),
        send: async () => {
          sends++;
          return { $metadata: {}, MessageId: "unexpected" };
        },
      });
      expect(send(tenant, message)).rejects.toMatchObject({
        outcome: "rejected",
        status: sendingStatus === "disabled" ? 409 : 503,
        code: sendingStatus === "disabled" ? "email_tenant_paused" : "email_provider_unavailable",
      });
    }
    const send = makeEmailSesSender({
      readTenant: async () => {
        throw new Error("Private provider diagnostic");
      },
      send: async () => {
        sends++;
        return { $metadata: {}, MessageId: "unexpected" };
      },
    });
    expect(send(tenant, message)).rejects.toMatchObject({
      outcome: "rejected",
      status: 503,
      code: "email_provider_unavailable",
    });
    expect(sends).toBe(0);
  });

  it("reports a missing previously provisioned native tenant as an unavailable provider before sending", async () => {
    const f = fixture();
    let sends = 0;
    const send = makeEmailSesSender({
      readTenant: (current) =>
        readEmailSesTenant(current, {
          requireExisting: true,
          operations: {
            ...f.operations,
            getTenant: async () => {
              throw Object.assign(new Error("Private diagnostic"), { name: "NotFoundException" });
            },
          },
        }),
      send: async () => {
        sends++;
        return { $metadata: {}, MessageId: "unexpected" };
      },
    });
    expect(send({ ...tenant, providerId: "deleted-native-tenant" }, message)).rejects.toMatchObject(
      {
        outcome: "rejected",
        status: 503,
        code: "email_provider_unavailable",
      },
    );
    expect(sends).toBe(0);
  });

  it("classifies a documented rejection as safe to release without retaining content", async () => {
    const send = makeEmailSesSender({
      readTenant: async () => tenant,
      send: async () => {
        throw Object.assign(new Error(message.text), { name: "MessageRejected" });
      },
    });
    const error = await send(tenant, message).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ outcome: "rejected", status: 422, code: "email_send_rejected" });
    expect(error).toBeInstanceOf(Error);
    if (error instanceof Error) {
      expect(error.cause).toBeUndefined();
      expect(error.message).not.toContain("token=private");
    }
  });

  it("distinguishes request rejection, throttling, and provider configuration outages", async () => {
    for (const [name, status, code] of [
      ["BadRequestException", 422, "email_send_rejected"],
      ["TooManyRequestsException", 429, "email_send_throttled"],
      ["LimitExceededException", 429, "email_send_throttled"],
      ["TenantSendingPausedException", 409, "email_tenant_paused"],
      ["AccessDeniedException", 503, "email_provider_unavailable"],
      ["ConfigurationSetDoesNotExistException", 503, "email_provider_unavailable"],
    ] as const) {
      const send = makeEmailSesSender({
        readTenant: async () => tenant,
        send: async () => {
          throw Object.assign(new Error(message.text), { name });
        },
      });
      const failure = await send(tenant, message).catch((cause: unknown) => cause);
      expect(failure).toMatchObject({ outcome: "rejected", status, code });
      expect((failure as Error).message).not.toContain("token=private");
      expect((failure as Error).cause).toBeUndefined();
    }
  });

  it("never resends network, server, unknown, or missing-receipt outcomes", async () => {
    for (const failure of [
      new Error(message.text),
      Object.assign(new Error(), { name: "MessageRejected", $metadata: { httpStatusCode: 503 } }),
      Object.assign(new Error(), {
        name: "FutureProviderException",
        $metadata: { httpStatusCode: 400 },
      }),
      undefined,
    ]) {
      let sends = 0;
      const send = makeEmailSesSender({
        readTenant: async () => tenant,
        send: async () => {
          sends++;
          if (failure) throw failure;
          return { $metadata: {} };
        },
      });
      expect(send(tenant, message)).rejects.toMatchObject({
        outcome: "ambiguous",
        code: "ambiguous_write_outcome",
      });
      expect(sends).toBe(1);
    }
  });
});
