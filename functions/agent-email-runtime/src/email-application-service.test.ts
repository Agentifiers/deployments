import {
  EmailSesSendError,
  makeEmailSesSender,
  type EmailSesSendFailure,
} from "@deployments-ai/agent-email/aws";
import type { EmailDomainResponse, EmailTenantResponse } from "@deployments-ai/api-contract/email";
import {
  DatabaseError,
  makeIdempotencyPersistence,
  tableForItemType,
  type DynamoDatabaseService,
  type IdempotencyExecution,
  type IdempotencyResponseProtector,
  type PlatformRecord,
} from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import {
  createAgentEmailApiHandler,
  type AgentEmailApiInvocation,
  type AgentEmailApiScope,
  type AgentEmailHttpEvent,
} from "./api-handler.ts";
import { isEmailApiOperation } from "./api-routes.ts";
import {
  createEmailApplicationService,
  type EmailApplicationService,
} from "./email-application-service.ts";
import type { EmailProviderRuntime } from "./email-provider-runtime.ts";

const scope = {
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
};
const message = {
  from: "Service <sender@example.com>",
  to: ["recipient@example.net"],
  subject: "Sign in",
  text: "https://example.com/auth?token=do-not-persist",
};
const responseProtector: IdempotencyResponseProtector = {
  prepare: async () => ({
    dispose: () => undefined,
    protect: async (value) => ({ value }),
  }),
  unprotect: async (value) => value.value,
};

function invocation(
  body: Readonly<Record<string, unknown>> | undefined,
  parameters: Readonly<Record<string, string>> = {},
  selectedScope: AgentEmailApiScope = scope,
): AgentEmailApiInvocation {
  return {
    body,
    parameters,
    query: {},
    scope: selectedScope,
    identity: { permissions: ["email:admin"], principalId: "test-principal", scope: selectedScope },
    idempotencyKey: "test-key",
  };
}

function fixture(options: { readonly now?: () => Date } = {}) {
  const records = new Map<string, PlatformRecord>();
  const recordKey = (record: PlatformRecord) =>
    `${tableForItemType(record.itemType)}:${record.pk}:${record.sk}`;
  const database: DynamoDatabaseService = {
    getRecord: async (table, key) => records.get(`${table}:${key.pk}:${key.sk}`),
    putRecord: async (record) => {
      records.set(recordKey(record), record);
    },
    deleteRecord: async (record) => {
      records.delete(recordKey(record));
    },
    queryRecords: async () => ({ items: [] }),
    transactWrite: async (operations) => {
      for (const operation of operations) {
        if (operation.kind === "condition-check") continue;
        const existing = records.get(recordKey(operation.record));
        if (
          (operation.kind === "put" && !operation.previousRecord && existing) ||
          (operation.kind === "delete" &&
            operation.record.itemType === "unique-claim" &&
            (existing?.itemType !== "unique-claim" ||
              existing.data.ownerId !== operation.record.data.ownerId))
        ) {
          throw new DatabaseError({
            cause: "ConditionalCheckFailedException",
            message: "Write conflict",
            operation: "transact-write",
            table: "control",
            reason: "conflict",
          });
        }
      }
      for (const operation of operations) {
        if (operation.kind === "condition-check") continue;
        if (operation.kind === "delete") records.delete(recordKey(operation.record));
        else records.set(recordKey(operation.record), operation.record);
      }
    },
  };
  let sends = 0;
  let sendOutcome: "accepted" | EmailSesSendFailure = "accepted";
  let nativeReadFails = false;
  let cleanupFails = false;
  const providers: EmailProviderRuntime = {
    provisionTenant: async (tenant) => ({ ...tenant, sendingStatus: "enabled" }),
    readTenant: async (tenant) => tenant,
    domainProvisioner: () => ({
      provision: async (domain) => ({
        ...domain,
        status: "verified",
        verifiedAt: "2026-09-16T00:00:00.000Z",
      }),
      refresh: async (domain) => domain,
      revoke: async (domain) => {
        if (cleanupFails) throw new Error("Provider cleanup is unavailable.");
        return { ...domain, status: "revoked", dnsRecords: [], providerMetadata: {} };
      },
    }),
    send: makeEmailSesSender({
      readTenant: async (tenant) => {
        if (nativeReadFails) throw new Error(message.text);
        return tenant;
      },
      send: async () => {
        sends += 1;
        if (sendOutcome !== "accepted") throw new EmailSesSendError(sendOutcome);
        return { $metadata: {}, MessageId: `ses-message-${sends}` };
      },
    }),
  };
  const service = createEmailApplicationService({
    database,
    providers,
    region: "us-east-2",
    ...options,
  });
  const idempotency = makeIdempotencyPersistence({ database, responseProtector });
  const handler = (permissions = ["email:admin"]) =>
    createAgentEmailApiHandler({
      authenticate: async () => ({ ...invocation(undefined).identity, permissions }),
      idempotency: {
        execute: async <T>(input: IdempotencyExecution) => (await idempotency.execute(input)) as T,
      },
      service: {
        execute: (operation, input) => {
          if (!isEmailApiOperation(operation)) throw new Error("Unexpected inbox operation.");
          return service.execute(operation, input);
        },
      },
    });
  return {
    records,
    service,
    handler,
    get sends() {
      return sends;
    },
    set sendOutcome(value: typeof sendOutcome) {
      sendOutcome = value;
    },
    set cleanupFails(value: boolean) {
      cleanupFails = value;
    },
    set nativeReadFails(value: boolean) {
      nativeReadFails = value;
    },
  };
}

async function tenantAndDomain(service: EmailApplicationService) {
  const tenant = (await service.execute(
    "createEmailTenant",
    invocation({ name: "Transactional" }),
  )) as EmailTenantResponse;
  const domain = (await service.execute(
    "createEmailDomain",
    invocation({ domain: "example.com" }, { tenantId: tenant.id }),
  )) as EmailDomainResponse;
  await service.execute("refreshEmailDomain", invocation(undefined, { domainId: domain.id }));
  return { tenant, domain };
}

function sendRequest(tenantId: string, key: string, body: unknown = message): AgentEmailHttpEvent {
  return {
    body: JSON.stringify(body),
    headers: { "x-deployments-environment": scope.environmentId, "idempotency-key": key },
    rawPath: `/v1/email/tenants/${tenantId}/messages`,
    requestContext: { http: { method: "POST" } },
  };
}

describe("generic scoped email application", () => {
  test("cannot send another tenant's verified From identity or read across environments", async () => {
    const runtime = fixture();
    const { tenant } = await tenantAndDomain(runtime.service);
    const other = (await runtime.service.execute(
      "createEmailTenant",
      invocation({ name: "Other" }),
    )) as EmailTenantResponse;
    expect(
      runtime.service.execute("sendEmail", invocation(message, { tenantId: other.id })),
    ).rejects.toMatchObject({ code: "email_domain_not_verified" });
    expect(
      runtime.service.execute(
        "getEmailTenant",
        invocation(
          undefined,
          { tenantId: tenant.id },
          {
            ...scope,
            environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
          },
        ),
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(runtime.sends).toBe(0);
  });

  test("authorizes the exact canonical IDN From domain rather than neighboring identities", async () => {
    const runtime = fixture();
    const tenant = (await runtime.service.execute(
      "createEmailTenant",
      invocation({ name: "International" }),
    )) as EmailTenantResponse;
    const domain = (await runtime.service.execute(
      "createEmailDomain",
      invocation(
        {
          domain: "BÜCHER.example.",
        },
        { tenantId: tenant.id },
      ),
    )) as EmailDomainResponse;
    await runtime.service.execute(
      "refreshEmailDomain",
      invocation(undefined, { domainId: domain.id }),
    );
    expect(
      await runtime.service.execute(
        "sendEmail",
        invocation(
          {
            ...message,
            from: '"Bücher" <Sender@xn--bcher-kva.example>',
          },
          { tenantId: tenant.id },
        ),
      ),
    ).toMatchObject({ status: "accepted" });
    expect(
      await runtime.service.execute(
        "sendEmail",
        invocation(
          {
            ...message,
            from: '"Bücher" <Sender@BÜCHER.example.>',
          },
          { tenantId: tenant.id },
        ),
      ),
    ).toMatchObject({ status: "accepted" });
    expect(
      runtime.service.execute(
        "sendEmail",
        invocation(
          {
            ...message,
            from: "sender@sub.bücher.example",
          },
          { tenantId: tenant.id },
        ),
      ),
    ).rejects.toMatchObject({ code: "email_domain_not_verified" });
    expect(runtime.sends).toBe(2);
  });

  test("rejects MIME expansion overflow before send and releases the durable key", async () => {
    const runtime = fixture();
    const { tenant } = await tenantAndDomain(runtime.service);
    const handler = runtime.handler();
    const rejected = await handler(
      sendRequest(tenant.id, "invalid-mailbox", {
        ...message,
        replyTo: [`"${"é".repeat(400)}" <reply@example.com>`],
      }),
    );
    expect(rejected.statusCode).toBe(400);
    expect(runtime.sends).toBe(0);
    expect((await handler(sendRequest(tenant.id, "invalid-mailbox"))).statusCode).toBe(202);
    expect(runtime.sends).toBe(1);
    expect(JSON.stringify([...runtime.records.values()])).not.toContain(message.text);
  });

  test("revocation blocks sending before failed provider cleanup and supports cleanup retry", async () => {
    const runtime = fixture();
    const { tenant, domain } = await tenantAndDomain(runtime.service);
    runtime.cleanupFails = true;
    expect(
      runtime.service.execute("revokeEmailDomain", invocation(undefined, { domainId: domain.id })),
    ).rejects.toThrow("Provider cleanup is unavailable.");
    expect(
      runtime.service.execute("sendEmail", invocation(message, { tenantId: tenant.id })),
    ).rejects.toMatchObject({ code: "email_domain_not_verified" });
    const successor = (await runtime.service.execute(
      "createEmailTenant",
      invocation({ name: "New owner" }),
    )) as EmailTenantResponse;
    const successorDomain = (await runtime.service.execute(
      "createEmailDomain",
      invocation({ domain: "example.com" }, { tenantId: successor.id }),
    )) as EmailDomainResponse;
    expect(
      runtime.service.execute(
        "refreshEmailDomain",
        invocation(undefined, { domainId: successorDomain.id }),
      ),
    ).rejects.toMatchObject({ reason: "conflict" });
    runtime.cleanupFails = false;
    expect(
      await runtime.service.execute(
        "revokeEmailDomain",
        invocation(undefined, { domainId: domain.id }),
      ),
    ).toMatchObject({ status: "revoked", dnsRecords: [] });
    expect(
      runtime.service.execute("refreshEmailDomain", invocation(undefined, { domainId: domain.id })),
    ).rejects.toMatchObject({ code: "email_domain_revoked" });
    expect(runtime.sends).toBe(0);
    expect(
      await runtime.service.execute(
        "refreshEmailDomain",
        invocation(undefined, { domainId: successorDomain.id }),
      ),
    ).toMatchObject({ status: "verified" });
    expect(
      await runtime.service.execute("sendEmail", invocation(message, { tenantId: successor.id })),
    ).toMatchObject({ status: "accepted" });
    // Replaying cleanup on the old revoked record cannot delete its successor's claim.
    await runtime.service.execute(
      "revokeEmailDomain",
      invocation(undefined, { domainId: domain.id }),
    );
    expect(
      await runtime.service.execute("sendEmail", invocation(message, { tenantId: successor.id })),
    ).toMatchObject({ status: "accepted" });
  });

  test("keeps ambiguous SES acceptance pending so replay never sends a duplicate", async () => {
    const runtime = fixture();
    const { tenant } = await tenantAndDomain(runtime.service);
    runtime.sendOutcome = "ambiguous";
    const handler = runtime.handler();
    expect((await handler(sendRequest(tenant.id, "uncertain-send"))).statusCode).toBe(500);
    runtime.sendOutcome = "accepted";
    const retry = await handler(sendRequest(tenant.id, "uncertain-send"));
    expect(retry.statusCode).toBe(409);
    expect(runtime.sends).toBe(1);
    expect(JSON.stringify([...runtime.records.values()])).not.toContain(message.text);
  });

  test("keeps acceptance pending when building the receipt fails after the provider sends", async () => {
    let failReceipt = false;
    const runtime = fixture({
      now: () => {
        if (failReceipt) throw new Error("Receipt clock unavailable.");
        return new Date("2026-09-16T00:00:00.000Z");
      },
    });
    const { tenant } = await tenantAndDomain(runtime.service);
    const handler = runtime.handler();
    failReceipt = true;
    expect((await handler(sendRequest(tenant.id, "receipt-failure"))).statusCode).toBe(500);
    failReceipt = false;
    expect((await handler(sendRequest(tenant.id, "receipt-failure"))).statusCode).toBe(409);
    expect(runtime.sends).toBe(1);
  });

  test("releases known rejection, replays accepted receipt, and persists no message content", async () => {
    const runtime = fixture();
    const { tenant } = await tenantAndDomain(runtime.service);
    const handler = runtime.handler();
    runtime.sendOutcome = "rejected";
    const rejected = await handler(sendRequest(tenant.id, "known-rejection"));
    expect(rejected.statusCode).toBe(422);
    expect(JSON.parse(rejected.body).code).toBe("email_send_rejected");
    runtime.sendOutcome = "accepted";
    const accepted = await handler(sendRequest(tenant.id, "known-rejection"));
    const replayed = await handler(sendRequest(tenant.id, "known-rejection"));
    expect(accepted.statusCode).toBe(202);
    expect(JSON.parse(accepted.body)).toMatchObject({
      status: "accepted",
      providerMessageId: "ses-message-2",
    });
    expect(replayed.body).toBe(accepted.body);
    expect(runtime.sends).toBe(2);
    expect(JSON.stringify([...runtime.records.values()])).not.toContain(message.text);
  });

  test("returns retryable throttling and permits the same durable key after rejection", async () => {
    const runtime = fixture();
    const { tenant } = await tenantAndDomain(runtime.service);
    const handler = runtime.handler();
    runtime.sendOutcome = "throttled";
    const throttled = await handler(sendRequest(tenant.id, "rate-limited"));
    expect(throttled.statusCode).toBe(429);
    expect(JSON.parse(throttled.body).code).toBe("email_send_throttled");
    runtime.sendOutcome = "accepted";
    expect((await handler(sendRequest(tenant.id, "rate-limited"))).statusCode).toBe(202);
    expect(runtime.sends).toBe(2);
  });

  test("releases a pre-send native lookup failure without sending or exposing provider diagnostics", async () => {
    const runtime = fixture();
    const { tenant } = await tenantAndDomain(runtime.service);
    const handler = runtime.handler();
    runtime.nativeReadFails = true;
    const unavailable = await handler(sendRequest(tenant.id, "native-unavailable"));
    expect(unavailable.statusCode).toBe(503);
    expect(JSON.parse(unavailable.body).code).toBe("email_provider_unavailable");
    expect(unavailable.body).not.toContain(message.text);
    expect(runtime.sends).toBe(0);
    runtime.nativeReadFails = false;
    expect((await handler(sendRequest(tenant.id, "native-unavailable"))).statusCode).toBe(202);
    expect(runtime.sends).toBe(1);
  });

  test("generic permissions are independent and unknown provider overrides are rejected", async () => {
    const runtime = fixture();
    const { tenant } = await tenantAndDomain(runtime.service);
    expect(
      (await runtime.handler(["agent-email:*"])(sendRequest(tenant.id, "wrong-permission")))
        .statusCode,
    ).toBe(403);
    expect(
      (await runtime.handler(["email:read"])(sendRequest(tenant.id, "read-only"))).statusCode,
    ).toBe(403);
    expect(
      (
        await runtime.handler()(
          sendRequest(tenant.id, "provider-override", {
            ...message,
            configurationSetName: "foreign",
          }),
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (await runtime.handler(["email:write"])(sendRequest(tenant.id, "allowed-send"))).statusCode,
    ).toBe(202);
    expect(runtime.sends).toBe(1);
  });
});
