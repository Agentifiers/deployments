import { describe, expect, it } from "bun:test";
import { agentEmailTenantObjectPrefix } from "../../core/index.ts";
import {
  deterministicAgentEmailUlid,
  processAgentEmailInboundReceipt,
  type AgentEmailInboundConsumerDependencies,
} from "./inbound-consumer.ts";

const raw = new TextEncoder().encode(
  [
    "From: Sender <sender@example.com>",
    "To: agent@agents.example.com",
    "Message-ID: <provider@example.com>",
    "Subject: Workflow request",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Please run the workflow.",
  ].join("\r\n"),
);

const rawWithExternalizedBodyAndAttachment = new TextEncoder().encode(
  [
    "From: Sender <sender@example.com>",
    "To: agent@agents.example.com",
    "Message-ID: <provider@example.com>",
    "Subject: Workflow request",
    'Content-Type: multipart/mixed; boundary="agent-email-boundary"',
    "",
    "--agent-email-boundary",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "x".repeat(300 * 1024),
    "--agent-email-boundary",
    "Content-Type: text/plain",
    'Content-Disposition: attachment; filename="notes.txt"',
    "Content-Transfer-Encoding: base64",
    "",
    "YXR0YWNobWVudA==",
    "--agent-email-boundary--",
  ].join("\r\n"),
);

const tenantPrefix = agentEmailTenantObjectPrefix({
  environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FB3",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FB4",
});

function dependencies(status: "active" | "paused" = "active") {
  const persisted: unknown[] = [];
  const dispatched: unknown[] = [];
  const deletes: string[] = [];
  const puts: string[] = [];
  const value: AgentEmailInboundConsumerDependencies = {
    blobs: {
      delete: async (key: string) => {
        deletes.push(key);
      },
      get: async () => new Uint8Array(),
      put: async ({ key }: { readonly key: string }) => {
        puts.push(key);
        return { created: true, etag: "etag", versionId: "version" };
      },
      signedGetUrl: async () => "https://example.invalid",
    },
    bucket: "agent-email",
    dispatch: async (input: unknown) => {
      dispatched.push(input);
    },
    isPersisted: async () => false,
    persist: async (input: unknown) => {
      persisted.push(input);
      return "persisted" as const;
    },
    reserve: async () => ({
      attachmentIds: [],
      eventId: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
      messageId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
      threadId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
      usageIds: {
        inboundMessage: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
        storedBytes: "01ARZ3NDEKTSV4RRFFQ69G5FB2",
      },
    }),
    resolveRecipients: async () => [
      {
        inbox: {
          address: "agent@agents.example.com",
          createdAt: "2026-07-25T00:00:00.000Z",
          domainId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
          id: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
          localPart: "agent",
          metadata: {},
          organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
          status,
          updatedAt: "2026-07-25T00:00:00.000Z",
        },
        environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FB3",
        projectId: "01ARZ3NDEKTSV4RRFFQ69G5FB4",
        rawRetentionDays: 30,
      },
    ],
  };
  return {
    deletes,
    dispatched,
    persisted,
    puts,
    value,
  };
}

function receipt(messageRaw: Uint8Array = raw) {
  return {
    completionKey: "raw/completed/provider-message",
    objectKey: "raw/provider-message",
    providerMessageId: "provider-message",
    providerRegion: "us-east-2",
    raw: messageRaw,
    rawReference: {
      bucket: "agent-email",
      etag: "raw-etag",
      key: "raw/provider-message",
      versionId: "raw-version",
    },
    receivedAt: "2026-07-25T00:00:00.000Z",
    recipients: ["agent@agents.example.com"],
  } as const;
}

describe("agent email inbound consumer", () => {
  it("derives stable canonical IDs from receipt identities", () => {
    const first = deterministicAgentEmailUlid(
      "2026-07-25T00:00:00.000Z",
      "us-east-2",
      "provider-message",
      "inbox",
      "message",
    );
    expect(first).toMatch(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u);
    expect(
      deterministicAgentEmailUlid(
        "2026-07-25T00:00:00.000Z",
        "us-east-2",
        "provider-message",
        "inbox",
        "message",
      ),
    ).toBe(first);
    expect(
      deterministicAgentEmailUlid(
        "2026-07-25T00:00:00.000Z",
        "us-east-2",
        "provider-message",
        "other-inbox",
        "message",
      ),
    ).not.toBe(first);
  });

  it("persists a received message before dispatching its workflow trigger", async () => {
    const fixture = dependencies();
    const outcomes = await processAgentEmailInboundReceipt(receipt(), fixture.value);

    expect(outcomes).toEqual([
      {
        inboxId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
        messageId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
        status: "persisted-and-dispatched",
      },
    ]);
    expect(fixture.persisted).toHaveLength(1);
    expect(fixture.dispatched).toHaveLength(1);
    expect(fixture.dispatched[0]).toMatchObject({
      bodySummary: "Please run the workflow.",
      message: { id: "01ARZ3NDEKTSV4RRFFQ69G5FAY" },
    });
    expect(fixture.persisted[0]).toMatchObject({
      bodyReferences: {
        rawReference: {
          bucket: "agent-email",
          byteSize: raw.byteLength,
          contentType: "message/rfc822",
          key: `raw/${tenantPrefix}/inboxes/01ARZ3NDEKTSV4RRFFQ69G5FAW/01ARZ3NDEKTSV4RRFFQ69G5FAY.eml`,
          versionId: "version",
        },
      },
      event: { eventType: "agent-email.received" },
      message: {
        direction: "inbound",
        fromAddress: "sender@example.com",
        providerMessageId: "provider-message",
        status: "received",
        textBody: "Please run the workflow.",
      },
      thread: { messageCount: 1, subject: "Workflow request" },
    });
    expect(fixture.persisted[0]).toMatchObject({
      usage: [
        { kind: "inbound_message", quantity: 1 },
        { kind: "stored_bytes", quantity: raw.byteLength },
      ],
    });
    expect(fixture.deletes).toEqual(["raw/provider-message"]);
    expect(fixture.puts).toContain("raw/completed/provider-message");
  });

  it("meters externalized inbound body bytes as stored content", async () => {
    const fixture = dependencies();
    Object.assign(fixture.value, {
      reserve: async () => ({
        attachmentIds: ["01ARZ3NDEKTSV4RRFFQ69G5FB5"],
        eventId: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
        messageId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
        threadId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
        usageIds: {
          attachmentBytes: "01ARZ3NDEKTSV4RRFFQ69G5FB3",
          inboundMessage: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
          storedBytes: "01ARZ3NDEKTSV4RRFFQ69G5FB2",
        },
      }),
    });

    await processAgentEmailInboundReceipt(
      receipt(rawWithExternalizedBodyAndAttachment),
      fixture.value,
    );
    const persisted = fixture.persisted[0] as {
      readonly attachments: readonly { readonly byteSize: number }[];
      readonly bodyReferences: {
        readonly textBodyRef?: { readonly byteSize: number };
      };
      readonly usage: readonly { readonly kind: string; readonly quantity: number }[];
    };
    const expectedStoredBytes =
      rawWithExternalizedBodyAndAttachment.byteLength +
      persisted.attachments.reduce((total, attachment) => total + attachment.byteSize, 0) +
      (persisted.bodyReferences.textBodyRef?.byteSize ?? 0);

    expect(persisted.usage.find((usage) => usage.kind === "stored_bytes")?.quantity).toBe(
      expectedStoredBytes,
    );
  });

  it("does not dispatch paused inboxes", async () => {
    const fixture = dependencies("paused");
    expect(processAgentEmailInboundReceipt(receipt(), fixture.value)).resolves.toEqual([
      {
        inboxId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
        status: "skipped-inactive",
      },
    ]);
    expect(fixture.persisted).toHaveLength(0);
    expect(fixture.dispatched).toHaveLength(0);
  });

  it("rejects mismatched raw object references before MIME processing", async () => {
    const fixture = dependencies();
    expect(
      processAgentEmailInboundReceipt(
        {
          ...receipt(),
          rawReference: { ...receipt().rawReference, key: "raw/other" },
        },
        fixture.value,
      ),
    ).rejects.toThrow("does not match");
  });

  it("deletes newly created raw, body, and attachment versions after an uncommitted persistence failure", async () => {
    const fixture = dependencies();
    Object.assign(fixture.value, {
      persist: async () => {
        throw new Error("DynamoDB unavailable");
      },
      reserve: async () => ({
        attachmentIds: ["01ARZ3NDEKTSV4RRFFQ69G5FB5"],
        eventId: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
        messageId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
        threadId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
        usageIds: {
          attachmentBytes: "01ARZ3NDEKTSV4RRFFQ69G5FB3",
          inboundMessage: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
          storedBytes: "01ARZ3NDEKTSV4RRFFQ69G5FB2",
        },
      }),
    });

    expect(
      processAgentEmailInboundReceipt(receipt(rawWithExternalizedBodyAndAttachment), fixture.value),
    ).rejects.toThrow("DynamoDB unavailable");

    expect(fixture.deletes).toHaveLength(3);
    expect(fixture.deletes).toContain(
      `raw/${tenantPrefix}/inboxes/01ARZ3NDEKTSV4RRFFQ69G5FAW/01ARZ3NDEKTSV4RRFFQ69G5FAY.eml`,
    );
    expect(
      fixture.deletes.some(
        (key) =>
          key.startsWith(`${tenantPrefix}/bodies/01ARZ3NDEKTSV4RRFFQ69G5FAW/`) &&
          key.endsWith("/body.txt"),
      ),
    ).toBe(true);
    expect(fixture.deletes).toContain(
      `${tenantPrefix}/attachments/01ARZ3NDEKTSV4RRFFQ69G5FAW/01ARZ3NDEKTSV4RRFFQ69G5FAY/01ARZ3NDEKTSV4RRFFQ69G5FB5`,
    );
    expect(fixture.dispatched).toHaveLength(0);
  });

  it("preserves created versions and dispatches when an ambiguous persistence failure committed", async () => {
    const fixture = dependencies();
    Object.assign(fixture.value, {
      isPersisted: async () => true,
      persist: async (input: unknown) => {
        fixture.persisted.push(input);
        throw new Error("DynamoDB response timed out");
      },
    });

    expect(processAgentEmailInboundReceipt(receipt(), fixture.value)).resolves.toEqual([
      {
        inboxId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
        messageId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
        status: "persisted-and-dispatched",
      },
    ]);

    expect(fixture.persisted).toHaveLength(1);
    expect(fixture.dispatched).toHaveLength(1);
    expect(fixture.deletes).toEqual(["raw/provider-message"]);
  });

  it("preserves created versions when persistence reconciliation fails", async () => {
    const fixture = dependencies();
    Object.assign(fixture.value, {
      isPersisted: async () => {
        throw new Error("DynamoDB reconciliation unavailable");
      },
      persist: async () => {
        throw new Error("DynamoDB response timed out");
      },
    });

    expect(processAgentEmailInboundReceipt(receipt(), fixture.value)).rejects.toThrow(
      "Failed to persist and reconcile inbound email content.",
    );
    expect(fixture.deletes).toEqual([]);
    expect(fixture.dispatched).toHaveLength(0);
  });

  it("settles a redelivered receipt whose message was erased without dispatching it", async () => {
    const fixture = dependencies();
    Object.assign(fixture.value, {
      persist: async () => "erased" as const,
      reserve: async () => ({
        attachmentIds: ["01ARZ3NDEKTSV4RRFFQ69G5FB5"],
        eventId: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
        messageId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
        threadId: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
        usageIds: {
          attachmentBytes: "01ARZ3NDEKTSV4RRFFQ69G5FB3",
          inboundMessage: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
          storedBytes: "01ARZ3NDEKTSV4RRFFQ69G5FB2",
        },
      }),
    });

    expect(
      await processAgentEmailInboundReceipt(
        receipt(rawWithExternalizedBodyAndAttachment),
        fixture.value,
      ),
    ).toEqual([
      {
        inboxId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
        messageId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
        status: "erased",
      },
    ]);
    expect(fixture.dispatched).toEqual([]);
    expect(fixture.deletes.filter((key) => !key.includes("/bodies/")).toSorted()).toEqual([
      `${tenantPrefix}/attachments/01ARZ3NDEKTSV4RRFFQ69G5FAW/01ARZ3NDEKTSV4RRFFQ69G5FAY/01ARZ3NDEKTSV4RRFFQ69G5FB5`,
      `raw/${tenantPrefix}/inboxes/01ARZ3NDEKTSV4RRFFQ69G5FAW/01ARZ3NDEKTSV4RRFFQ69G5FAY.eml`,
      "raw/provider-message",
    ]);
    expect(
      fixture.deletes.filter(
        (key) =>
          key.startsWith(`${tenantPrefix}/bodies/01ARZ3NDEKTSV4RRFFQ69G5FAW/`) &&
          key.endsWith("/body.txt"),
      ),
    ).toHaveLength(1);
  });
});
