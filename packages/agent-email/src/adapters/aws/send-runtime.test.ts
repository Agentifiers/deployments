import { describe, expect, it } from "bun:test";
import {
  AgentEmailRejectedReceiptError,
  agentEmailTransitionForProviderEvent,
  parseAgentEmailProviderEvent,
  parseSesReceiptObjectKey,
  prepareAgentEmailSend,
} from "./runtime.ts";

describe("agent email SES send runtime", () => {
  it("prepares a tenant-scoped SES request", () => {
    const request = {
      attachments: [],
      configurationSetName: "agent-email",
      endpointId: "global-endpoint",
      message: {
        attachments: [],
        bccAddresses: [],
        ccAddresses: [],
        createdAt: "2026-07-20T00:00:00.000Z",
        direction: "outbound",
        fromAddress: "agent@agents.example.com",
        id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        inboxId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
        organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
        reprocessCount: 0,
        references: [],
        replyToAddresses: [],
        status: "queued",
        subject: "Hello",
        textBody: "Hello",
        threadKey: "thread",
        toAddresses: ["recipient@example.com"],
        updatedAt: "2026-07-20T00:00:00.000Z",
      },
    } as const;
    const input = prepareAgentEmailSend({ ...request, tenantName: "agent-inboxes-tenant" });
    expect(input.TenantName).toBe("agent-inboxes-tenant");
    expect(input.EndpointId).toBe("global-endpoint");
    expect(input.Destination?.ToAddresses).toEqual(["recipient@example.com"]);
    expect(prepareAgentEmailSend(request)).not.toHaveProperty("TenantName");
  });

  it("uses base64 MIME transfer encoding for binary attachments", () => {
    const content = Uint8Array.from([0, 255, 128, 200]);
    const input = prepareAgentEmailSend({
      attachments: [
        {
          byteSize: content.byteLength,
          content,
          contentType: "application/octet-stream",
          disposition: "attachment",
          fileName: "binary.dat",
          id: "attachment_1",
          messageId: "message_1",
          sha256: "sha256",
        },
      ],
      configurationSetName: "agent-email",
      message: {
        attachments: [],
        bccAddresses: [],
        ccAddresses: [],
        createdAt: "2026-07-20T00:00:00.000Z",
        direction: "outbound",
        fromAddress: "agent@agents.example.com",
        id: "message_1",
        inboxId: "inbox_1",
        organizationId: "org_1",
        references: [],
        replyToAddresses: [],
        reprocessCount: 0,
        status: "queued",
        subject: "Binary attachment",
        textBody: "Attached.",
        threadKey: "thread_1",
        toAddresses: ["recipient@example.com"],
        updatedAt: "2026-07-20T00:00:00.000Z",
      },
      tenantName: "agent-inboxes-tenant",
    });

    expect(input.Content?.Simple?.Attachments?.[0]).toMatchObject({
      ContentTransferEncoding: "BASE64",
      FileName: "binary.dat",
    });
    expect(input.Content?.Simple?.Attachments?.[0]?.RawContent).toEqual(content);
  });

  it("rejects messages whose encoded MIME size exceeds the SES limit", () => {
    const content = new Uint8Array(28 * 1024 * 1024);
    expect(() =>
      prepareAgentEmailSend({
        attachments: [
          {
            byteSize: content.byteLength,
            content,
            contentType: "application/octet-stream",
            disposition: "attachment",
            fileName: "oversized.dat",
            id: "attachment_1",
            messageId: "message_1",
            sha256: "sha256",
          },
        ],
        configurationSetName: "agent-email",
        message: {
          attachments: [],
          bccAddresses: [],
          ccAddresses: [],
          createdAt: "2026-07-20T00:00:00.000Z",
          direction: "outbound",
          fromAddress: "agent@agents.example.com",
          id: "message_1",
          inboxId: "inbox_1",
          organizationId: "org_1",
          references: [],
          replyToAddresses: [],
          reprocessCount: 0,
          status: "queued",
          subject: "Oversized attachment",
          textBody: "Attached.",
          threadKey: "thread_1",
          toAddresses: ["recipient@example.com"],
          updatedAt: "2026-07-20T00:00:00.000Z",
        },
        tenantName: "agent-inboxes-tenant",
      }),
    ).toThrow("40 MB encoded message limit");
  });

  it("synthesizes an empty text part for bodyless outbound messages", () => {
    const input = prepareAgentEmailSend({
      attachments: [],
      configurationSetName: "agent-email",
      message: {
        attachments: [],
        bccAddresses: [],
        ccAddresses: [],
        createdAt: "2026-07-20T00:00:00.000Z",
        direction: "outbound",
        fromAddress: "agent@agents.example.com",
        id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        inboxId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
        organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
        reprocessCount: 0,
        references: [],
        replyToAddresses: [],
        status: "queued",
        subject: "Subject only",
        threadKey: "thread",
        toAddresses: ["recipient@example.com"],
        updatedAt: "2026-07-20T00:00:00.000Z",
      },
      tenantName: "agent-inboxes-tenant",
    });

    expect(input.Content?.Simple?.Body?.Text).toEqual({ Charset: "UTF-8", Data: "" });
  });

  it("normalizes SES provider events and transitions", () => {
    const normalized = parseAgentEmailProviderEvent({
      body: JSON.stringify({
        eventType: "Delivery",
        delivery: { timestamp: "2026-07-20T00:00:01.000Z" },
        mail: {
          messageId: "ses-message",
          tags: { agentEmailMessageId: ["01ARZ3NDEKTSV4RRFFQ69G5FAV"] },
        },
      }),
      messageId: "queue-message",
    });
    expect(normalized.eventType).toBe("DELIVERY");
    expect(normalized.taggedMessageId).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(agentEmailTransitionForProviderEvent(normalized.eventType, "accepted")).toEqual({
      eventType: "agent-email.delivered",
      status: "delivered",
    });
    expect(agentEmailTransitionForProviderEvent("SEND", "delivered")).toBeUndefined();
    expect(agentEmailTransitionForProviderEvent("DELIVERY", "bounced")).toBeUndefined();
    expect(agentEmailTransitionForProviderEvent("BOUNCE", "delivered")).toEqual({
      eventType: "agent-email.bounced",
      status: "bounced",
    });
    expect(agentEmailTransitionForProviderEvent("COMPLAINT", "bounced")).toEqual({
      eventType: "agent-email.complained",
      status: "complained",
    });
  });

  it("extracts S3 receipt routing details", () => {
    expect(
      parseSesReceiptObjectKey({
        body: JSON.stringify({
          mail: { messageId: "ses-inbound", timestamp: "2026-07-25T00:00:00Z" },
          receipt: {
            action: { bucketName: "legacy-agent-email", objectKey: "raw/ses-inbound" },
            dkimVerdict: { status: "PASS" },
            recipients: ["agent@agents.example.com"],
            spamVerdict: { status: "PASS" },
            spfVerdict: { status: "PASS" },
            virusVerdict: { status: "PASS" },
          },
        }),
        messageId: "queue-message",
      }),
    ).toEqual({
      bucket: "legacy-agent-email",
      messageId: "ses-inbound",
      objectKey: "raw/ses-inbound",
      receivedAt: "2026-07-25T00:00:00.000Z",
      recipients: ["agent@agents.example.com"],
      verdicts: { dkim: "PASS", spam: "PASS", spf: "PASS", virus: "PASS" },
    });
    let rejected: unknown;
    try {
      parseSesReceiptObjectKey({
        body: JSON.stringify({
          mail: { messageId: "ses-inbound", timestamp: "2026-07-25T00:00:00Z" },
          receipt: {
            action: { objectKey: "raw/ses-inbound" },
            recipients: ["agent@agents.example.com"],
            spamVerdict: { status: "FAIL" },
            virusVerdict: { status: "PASS" },
          },
        }),
        messageId: "queue-message",
      });
    } catch (cause) {
      rejected = cause;
    }
    expect(rejected).toBeInstanceOf(AgentEmailRejectedReceiptError);
    expect(rejected).toMatchObject({
      objectKey: "raw/ses-inbound",
      verdict: "spamVerdict",
    });
  });

  it("accounts for encoded non-ASCII bodies in the SES message limit", () => {
    expect(() =>
      prepareAgentEmailSend({
        attachments: [],
        configurationSetName: "agent-email",
        message: {
          attachments: [],
          bccAddresses: [],
          ccAddresses: [],
          createdAt: "2026-07-20T00:00:00.000Z",
          direction: "outbound",
          fromAddress: "agent@agents.example.com",
          id: "message_1",
          inboxId: "inbox_1",
          organizationId: "org_1",
          references: [],
          replyToAddresses: [],
          reprocessCount: 0,
          status: "queued",
          subject: "Encoded body",
          textBody: "é".repeat(7_000_000),
          threadKey: "thread_1",
          toAddresses: ["recipient@example.com"],
          updatedAt: "2026-07-20T00:00:00.000Z",
        },
        tenantName: "agent-inboxes-tenant",
      }),
    ).toThrow("40 MB encoded message limit");
  });
});
