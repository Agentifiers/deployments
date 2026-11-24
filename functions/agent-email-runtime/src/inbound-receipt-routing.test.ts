import {
  agentEmailTenantObjectPrefix,
  type AgentEmailMessageRecord,
} from "@deployments-ai/agent-email";
import { AgentEmailRejectedReceiptError } from "@deployments-ai/agent-email/aws";
import type { PlatformRecord, Ulid } from "@deployments-ai/db";
import { AgentEmailPersistenceError, inboxMessageRecord } from "@deployments-ai/db";
import { ListObjectVersionsCommand } from "@aws-sdk/client-s3";
import { describe, expect, it, mock, spyOn } from "bun:test";
import {
  agentEmailInboundErrorDiagnostic,
  agentEmailInboundReceiptCompletionKey,
  agentEmailInboundRouteIsActive,
  deterministicInboundReservation,
  discardRejectedAgentEmailReceipt,
  handler,
  headAgentEmailInboundObject,
  handleAgentEmailInboundQueue,
  loadAgentEmailInboundReceiptSource,
  loadRetainedAgentEmailRaw,
  resolveAgentEmailRawRetentionDays,
  type AgentEmailInboundMainDependencies,
} from "./inbound-main.ts";
import { AgentEmailInboundOperationError } from "./inbound-error-diagnostics.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid;
const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as Ulid;
const ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX" as Ulid;
const INBOX_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY" as Ulid;
const MESSAGE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAZ" as Ulid;
const NOW = "2026-07-26T12:00:00.000Z";

const scope = {
  environmentId: ENVIRONMENT_ID,
  organizationId: ORGANIZATION_ID,
  projectId: PROJECT_ID,
};
const tenantPrefix = agentEmailTenantObjectPrefix(scope);

function previousMessage() {
  const message: AgentEmailMessageRecord = {
    attachments: [],
    bccAddresses: [],
    ccAddresses: [],
    createdAt: "2026-07-25T12:00:00.000Z",
    direction: "inbound",
    fromAddress: "sender@example.com",
    id: MESSAGE_ID,
    inboxId: INBOX_ID,
    organizationId: ORGANIZATION_ID,
    receivedAt: "2026-07-25T12:00:00.000Z",
    references: [],
    replyToAddresses: [],
    reprocessCount: 0,
    status: "received",
    subject: "Original",
    textBody: "Original body",
    threadKey: "thread",
    toAddresses: ["agent@example.com"],
    updatedAt: "2026-07-25T12:00:00.000Z",
  };
  return inboxMessageRecord(scope, message, [], {
    rawReference: {
      bucket: "agent-email",
      byteSize: 100,
      contentType: "message/rfc822",
      key: `raw/${tenantPrefix}/inboxes/${INBOX_ID}/${MESSAGE_ID}.eml`,
      sha256: "raw-sha",
      versionId: "raw-version",
    },
  });
}

function runtime() {
  const receipts: string[] = [];
  const workflows: unknown[] = [];
  const value: AgentEmailInboundMainDependencies = {
    processReceipt: async (record) => {
      receipts.push(record.messageId);
    },
    processReprocess: async (input) => {
      workflows.push(input);
    },
    processWorkflow: async (input) => {
      workflows.push(input);
      if (
        input &&
        typeof input === "object" &&
        (input as Readonly<Record<string, unknown>>).messageId === "fail"
      ) {
        throw new Error("workflow failed");
      }
    },
  };
  return { receipts, value, workflows };
}

describe("agent email inbound Lambda composition", () => {
  it("keeps the Lambda context out of injectable inbound dependencies", () => {
    expect(handler).not.toBe(handleAgentEmailInboundQueue);
    expect(handler.length).toBe(1);
  });

  it("probes an exact versioned key without requiring bucket-wide HeadObject visibility", async () => {
    const responses = [
      {
        Versions: [
          { IsLatest: true, Key: "raw/completed/receipt", VersionId: "completion-version" },
        ],
      },
      { Versions: [{ IsLatest: true, Key: "raw/source-longer", VersionId: "other-version" }] },
      {
        DeleteMarkers: [{ IsLatest: true, Key: "raw/deleted", VersionId: "delete-marker-version" }],
      },
    ];
    const send = mock(async (command: ListObjectVersionsCommand) => {
      expect(command).toBeInstanceOf(ListObjectVersionsCommand);
      expect(command.input.MaxKeys).toBe(2);
      return responses.shift()!;
    });

    expect(
      headAgentEmailInboundObject({ send } as never, "agent-email", "raw/completed/receipt"),
    ).resolves.toEqual({ versionId: "completion-version" });
    expect(
      headAgentEmailInboundObject({ send } as never, "agent-email", "raw/source"),
    ).resolves.toBeUndefined();
    expect(
      headAgentEmailInboundObject({ send } as never, "agent-email", "raw/deleted"),
    ).resolves.toBeUndefined();
    expect(send.mock.calls.map(([command]) => command.input.Prefix)).toEqual([
      "raw/completed/receipt",
      "raw/source",
      "raw/deleted",
    ]);
  });

  it("acknowledges a redelivered receipt only after durable completion", async () => {
    const completionKey = agentEmailInboundReceiptCompletionKey("raw/", {
      messageId: "provider-message",
      objectKey: "raw/provider-message",
      receivedAt: NOW,
    });
    const deleted: { readonly key: string; readonly versionId?: string }[] = [];
    let loads = 0;

    expect(
      loadAgentEmailInboundReceiptSource(
        { completionKey, objectKey: "raw/provider-message" },
        {
          deleteRaw: async (key, versionId) => {
            deleted.push({ key, ...(versionId ? { versionId } : {}) });
          },
          head: async (key) => (key === completionKey ? {} : { versionId: "source-version" }),
          load: async () => {
            loads += 1;
            return { raw: new Uint8Array() };
          },
        },
      ),
    ).resolves.toBeUndefined();

    expect(completionKey).toMatch(/^raw\/completed\/[0-9a-f]{64}$/u);
    expect(deleted).toEqual([{ key: "raw/provider-message", versionId: "source-version" }]);
    expect(loads).toBe(0);
  });

  it("fails closed when a missing receipt has no completion marker", async () => {
    expect(
      loadAgentEmailInboundReceiptSource(
        {
          completionKey: "raw/completed/provider-message",
          objectKey: "raw/provider-message",
        },
        {
          deleteRaw: async () => {},
          head: async () => undefined,
          load: async () => ({ raw: new Uint8Array() }),
        },
      ),
    ).rejects.toThrow("missing without a durable completion marker");
  });

  it("routes inbound mail only through active inboxes with verified domains", () => {
    const inbox = {
      data: {
        domainId: "domain",
        environmentId: ENVIRONMENT_ID,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        status: "active",
      },
      itemType: "inbox",
    } as PlatformRecord;
    const environment = {
      data: {
        id: ENVIRONMENT_ID,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        status: "active",
      },
      itemType: "environment",
    } as PlatformRecord;
    const domain = {
      data: {
        environmentId: ENVIRONMENT_ID,
        id: "domain",
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        status: "verified",
      },
      itemType: "inbox-domain",
    } as PlatformRecord;

    expect(agentEmailInboundRouteIsActive(inbox, environment, domain)).toBe(true);
    expect(
      agentEmailInboundRouteIsActive(inbox, environment, {
        ...domain,
        data: { ...domain.data, status: "revoked" },
      } as PlatformRecord),
    ).toBe(false);
  });

  it("uses default raw retention before an environment policy is created", () => {
    expect(resolveAgentEmailRawRetentionDays([], "01ARZ3NDEKTSV4RRFFQ69G5FAA" as never)).toBe(30);
  });

  it("deletes and acknowledges an immutable rejected SES receipt", async () => {
    const deleted: (readonly [string, string | undefined])[] = [];
    expect(
      discardRejectedAgentEmailReceipt(
        new AgentEmailRejectedReceiptError("raw/rejected-message", "virusVerdict", "FAIL"),
        {
          deleteRaw: async (key, versionId) => {
            deleted.push([key, versionId]);
          },
          loadRaw: async () => ({ versionId: "rejected-version" }),
          rawPrefix: "raw/",
        },
      ),
    ).resolves.toEqual({ disposition: "rejected" });
    expect(deleted).toEqual([["raw/rejected-message", "rejected-version"]]);
  });

  it("fails closed before deleting a rejected receipt outside the raw prefix", async () => {
    let loaded = false;
    expect(
      discardRejectedAgentEmailReceipt(
        new AgentEmailRejectedReceiptError("other/message", "spamVerdict", "FAIL"),
        {
          deleteRaw: async () => {},
          loadRaw: async () => {
            loaded = true;
            return undefined;
          },
          rawPrefix: "raw/",
        },
      ),
    ).rejects.toThrow("outside the configured raw prefix");
    expect(loaded).toBe(false);
  });

  it("routes SES receipts and workflow commands through one ordered worker", async () => {
    const fixture = runtime();
    expect(
      handleAgentEmailInboundQueue(
        {
          Records: [
            { body: JSON.stringify({ mail: {} }), messageId: "receipt-1" },
            {
              body: JSON.stringify({
                messageId: "workflow-message",
                type: "agent-email.inbound-workflow",
              }),
              messageId: "workflow-1",
            },
          ],
        },
        fixture.value,
      ),
    ).resolves.toEqual({ batchItemFailures: [] });
    expect(fixture.receipts).toEqual(["receipt-1"]);
    expect(fixture.workflows).toEqual([
      { messageId: "workflow-message", type: "agent-email.inbound-workflow" },
    ]);
  });

  it("returns partial failures without replaying successful queue records", async () => {
    const fixture = runtime();
    expect(
      handleAgentEmailInboundQueue(
        {
          Records: [
            {
              body: JSON.stringify({
                messageId: "fail",
                type: "agent-email.inbound-workflow",
              }),
              messageId: "failed-record",
            },
            { body: "not-json", messageId: "receipt-2" },
          ],
        },
        fixture.value,
      ),
    ).resolves.toEqual({
      batchItemFailures: [{ itemIdentifier: "failed-record" }],
    });
    expect(fixture.receipts).toEqual(["receipt-2"]);
  });

  it("logs safe structured details for tagged inbound database failures", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    const nestedCause = Object.assign(new Error("Authorization: Bearer must-not-log"), {
      $metadata: { httpStatusCode: 403 },
      name: "AccessDeniedException",
    });
    const databaseFailure = {
      _tag: "DatabaseError",
      cause: nestedCause,
      message: "database detail must-not-log",
      operation: "get",
      reason: "unknown",
      table: "control",
    };
    const failure = new AgentEmailInboundOperationError(
      "process-receipt",
      new AgentEmailPersistenceError({
        cause: databaseFailure,
        message: "persistence detail must-not-log",
        operation: "persist-message",
      }),
    );
    try {
      expect(
        handleAgentEmailInboundQueue(
          { Records: [{ body: "not-json", messageId: "failed-record" }] },
          {
            processReceipt: async () => {
              throw failure;
            },
            processReprocess: async () => {},
            processWorkflow: async () => {},
          },
        ),
      ).resolves.toEqual({
        batchItemFailures: [{ itemIdentifier: "failed-record" }],
      });
      expect(agentEmailInboundErrorDiagnostic(failure)).toEqual({
        databaseOperation: "get",
        databaseReason: "unknown",
        databaseTable: "control",
        errorType: "DatabaseError",
        inboundOperations: ["process-receipt"],
        nestedErrorType: "AccessDeniedException",
        persistenceOperation: "persist-message",
        providerStatusCode: 403,
      });
      expect(consoleError).toHaveBeenCalledWith("Agent email inbound queue record failed.", {
        databaseOperation: "get",
        databaseReason: "unknown",
        databaseTable: "control",
        errorType: "DatabaseError",
        inboundOperations: ["process-receipt"],
        messageId: "failed-record",
        nestedErrorType: "AccessDeniedException",
        persistenceOperation: "persist-message",
        providerStatusCode: 403,
      });
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain("must-not-log");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("routes explicit raw-message reprocessing commands", async () => {
    const fixture = runtime();
    const command = {
      environmentId: "environment",
      inboxId: "inbox",
      messageId: "message",
      organizationId: "organization",
      projectId: "project",
      reprocessId: "request",
      type: "agent-email.reprocess",
      version: 1,
    };
    expect(
      handleAgentEmailInboundQueue(
        {
          Records: [
            {
              body: JSON.stringify(command),
              messageId: "reprocess-record",
            },
          ],
        },
        fixture.value,
      ),
    ).resolves.toEqual({ batchItemFailures: [] });
    expect(fixture.receipts).toEqual([]);
    expect(fixture.workflows).toEqual([command]);
  });

  it("rejects an expired queued reprocess command before reading its raw blob", async () => {
    const previous = previousMessage();
    let blobGets = 0;
    expect(
      loadRetainedAgentEmailRaw(
        {
          ...previous,
          data: {
            ...previous.data,
            rawRetentionExpiresAt: "2026-07-26T11:59:59.000Z",
          },
        },
        {
          blobs: {
            delete: async () => {},
            get: async () => {
              blobGets += 1;
              return new Uint8Array();
            },
            put: async () => {},
            signedGetUrl: async () => "https://example.invalid",
          },
          bucket: "agent-email",
          checkedAt: NOW,
        },
      ),
    ).rejects.toThrow("raw reference is unavailable");
    expect(blobGets).toBe(0);
  });

  it("keeps message IDs receipt-specific and thread IDs stable across a conversation", () => {
    const first = deterministicInboundReservation(
      {
        providerMessageId: "provider-1",
        providerRegion: "us-east-2",
        receivedAt: "2026-07-25T00:00:00.000Z",
      },
      {
        attachmentCount: 2,
        inboxId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
        threadKey: "<root@example.com>",
      },
    );
    const reply = deterministicInboundReservation(
      {
        providerMessageId: "provider-2",
        providerRegion: "us-east-2",
        receivedAt: "2026-07-26T00:00:00.000Z",
      },
      {
        attachmentCount: 0,
        inboxId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
        threadKey: "<root@example.com>",
      },
    );
    expect(first.messageId).not.toBe(reply.messageId);
    expect(first.threadId).toBe(reply.threadId);
    expect(first.attachmentIds).toHaveLength(2);
    expect(first.usageIds.attachmentBytes).toBeDefined();
    expect(reply.usageIds.attachmentBytes).toBeUndefined();
  });
});
