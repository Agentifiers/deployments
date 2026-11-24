import {
  agentEmailTenantObjectPrefix,
  type AgentEmailBlobStore,
  type AgentEmailMessageRecord,
} from "@deployments-ai/agent-email";
import { type ParsedInboundAgentEmail } from "@deployments-ai/agent-email/aws";
import type { PlatformRecord, Ulid } from "@deployments-ai/db";
import {
  inboxAttachmentRecord,
  inboxContentCleanupRecord,
  inboxMessageRecord,
  type AgentEmailMessageBodyReferenceUpdate,
} from "@deployments-ai/db";
import { describe, expect, it } from "bun:test";
import {
  deterministicInboundReservation,
  persistAgentEmailReprocess,
  resolveInboundThreadReservation,
} from "./inbound-main.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid;
const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as Ulid;
const ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX" as Ulid;
const INBOX_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY" as Ulid;
const MESSAGE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAZ" as Ulid;
const THREAD_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB0" as Ulid;
const NOW = "2026-07-26T12:00:00.000Z";

const scope = {
  environmentId: ENVIRONMENT_ID,
  organizationId: ORGANIZATION_ID,
  projectId: PROJECT_ID,
};
const tenantPrefix = agentEmailTenantObjectPrefix(scope);

const command = {
  environmentId: ENVIRONMENT_ID,
  inboxId: INBOX_ID,
  messageId: MESSAGE_ID,
  organizationId: ORGANIZATION_ID,
  projectId: PROJECT_ID,
  reprocessId: "reprocess-attempt",
};

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

function parsedMessage(): ParsedInboundAgentEmail {
  return {
    attachments: [
      {
        byteSize: 3,
        content: new Uint8Array([1, 2, 3]),
        contentType: "text/plain",
        disposition: "attachment",
        fileName: "new.txt",
        sha256: "attachment-sha",
      },
    ],
    bccAddresses: [],
    ccAddresses: [],
    fromAddress: "sender@example.com",
    references: [],
    replyToAddresses: [],
    subject: "Reprocessed",
    textBody: "x".repeat(300 * 1024),
    threadKey: "thread",
    toAddresses: ["agent@example.com"],
  };
}

function blobStore(input: {
  readonly delete: AgentEmailBlobStore["delete"];
  readonly put: AgentEmailBlobStore["put"];
}): AgentEmailBlobStore {
  return {
    delete: input.delete,
    get: async () => new Uint8Array(),
    put: input.put,
    signedGetUrl: async () => "https://example.invalid",
  };
}

describe("agent email inbound Lambda composition", () => {
  it("reuses the outbound thread for an inbound reply Internet Message-ID", async () => {
    const deterministic = deterministicInboundReservation(
      {
        providerMessageId: "provider-reply",
        providerRegion: "us-east-2",
        receivedAt: NOW,
      },
      {
        attachmentCount: 0,
        inboxId: INBOX_ID,
        threadKey: "<outbound@example.com>",
      },
    );
    const resolved = await resolveInboundThreadReservation(
      {
        providerMessageId: "provider-reply",
        providerRegion: "us-east-2",
        receivedAt: NOW,
      },
      {
        attachmentCount: 0,
        inboxId: INBOX_ID,
        organizationId: ORGANIZATION_ID,
        threadKey: "<outbound@example.com>",
      },
      async () => ({ inboxThreadId: THREAD_ID, kind: "live" }),
    );

    expect(resolved.messageId).toBe(deterministic.messageId);
    expect(resolved.threadId).toBe(THREAD_ID);
    expect(resolved.threadId).not.toBe(deterministic.threadId);
  });

  it("reuses attachment IDs by persisted MIME ordinal during reprocessing", async () => {
    const firstId = "01ARZ3NDEKTSV4RRFFQ69G5FB1" as Ulid;
    const secondId = "01ARZ3NDEKTSV4RRFFQ69G5FB2" as Ulid;
    const previous = previousMessage();
    const attachment = {
      bucket: "agent-email",
      byteSize: 3,
      contentType: "text/plain",
      disposition: "attachment" as const,
      fileName: "old.txt",
      key: "attachments/old",
      sha256: "old-sha",
    };
    const oldAttachments = [
      inboxAttachmentRecord(
        scope,
        MESSAGE_ID,
        { ...attachment, id: secondId },
        previous.data.createdAt,
        1,
      ),
      inboxAttachmentRecord(
        scope,
        MESSAGE_ID,
        { ...attachment, id: firstId },
        previous.data.createdAt,
        0,
      ),
    ];
    const parsed = parsedMessage();
    const replacement = {
      ...parsed,
      attachments: [
        parsed.attachments[0]!,
        {
          ...parsed.attachments[0]!,
          fileName: "second.txt",
          sha256: "second-sha",
        },
      ],
    };
    let persistedIds: readonly Ulid[] = [];
    let durableCleanup:
      | Extract<PlatformRecord, { readonly itemType: "inbox-content-cleanup" }>
      | undefined;

    await persistAgentEmailReprocess(command, previous, oldAttachments, replacement, {
      blobs: blobStore({
        delete: async () => {},
        put: async () => ({ created: true, versionId: "version" }),
      }),
      bucket: "agent-email",
      completeContentCleanup: async (cleanup) => {
        durableCleanup = {
          ...cleanup,
          data: { ...cleanup.data, status: "completed", version: cleanup.data.version + 1 },
        };
      },
      loadContentCleanup: async () => durableCleanup,
      loadDurableMessage: async () => previous,
      now: () => new Date(NOW),
      updateMessage: async (_current, _updated, _event, _bodyReferences, attachments, cleanup) => {
        persistedIds = attachments.map((value) => value.id);
        durableCleanup = inboxContentCleanupRecord(scope, cleanup);
      },
    });

    expect(persistedIds).toEqual([firstId, secondId]);
  });

  it("cleans up reprocessing attachments when body externalization fails", async () => {
    const deleted: string[] = [];
    expect(
      persistAgentEmailReprocess(command, previousMessage(), [], parsedMessage(), {
        blobs: blobStore({
          delete: async (key) => {
            deleted.push(key);
          },
          put: async ({ key }) => {
            if (key.includes("/bodies/")) {
              throw new Error("body upload failed");
            }
            return { created: true, versionId: "attachment-version" };
          },
        }),
        bucket: "agent-email",
        completeContentCleanup: async () => {},
        loadContentCleanup: async () => undefined,
        loadDurableMessage: async () => previousMessage(),
        now: () => new Date(NOW),
        updateMessage: async () => {
          throw new Error("must not update");
        },
      }),
    ).rejects.toThrow("body upload failed");
    expect(deleted).toEqual([
      expect.stringMatching(
        new RegExp(`^${tenantPrefix}/attachments/${INBOX_ID}/${MESSAGE_ID}/[^/]+/[^/]+$`, "u"),
      ),
    ]);
  });

  it("cleans up attachment and body versions when the durable update fails", async () => {
    const deleted: string[] = [];
    expect(
      persistAgentEmailReprocess(command, previousMessage(), [], parsedMessage(), {
        blobs: blobStore({
          delete: async (key) => {
            deleted.push(key);
          },
          put: async ({ key }) => ({
            created: true,
            versionId: key.includes("/bodies/") ? "body-version" : "attachment-version",
          }),
        }),
        bucket: "agent-email",
        completeContentCleanup: async () => {},
        loadContentCleanup: async () => undefined,
        loadDurableMessage: async () => previousMessage(),
        now: () => new Date(NOW),
        updateMessage: async () => {
          throw new Error("DynamoDB rejected update");
        },
      }),
    ).rejects.toThrow("DynamoDB rejected update");
    expect(deleted).toHaveLength(2);
    expect(deleted.some((key) => key.startsWith(`${tenantPrefix}/attachments/`))).toBe(true);
    expect(deleted.some((key) => key.startsWith(`${tenantPrefix}/bodies/`))).toBe(true);
  });

  it("preserves new versions when a timed-out reprocessing update committed", async () => {
    const deleted: string[] = [];
    let durable: Extract<PlatformRecord, { readonly itemType: "inbox-message" }> | undefined;
    let durableCleanup:
      | Extract<PlatformRecord, { readonly itemType: "inbox-content-cleanup" }>
      | undefined;
    const previous = previousMessage();
    expect(
      persistAgentEmailReprocess(command, previous, [], parsedMessage(), {
        blobs: blobStore({
          delete: async (key) => {
            deleted.push(key);
          },
          put: async ({ key }) => ({
            created: true,
            versionId: key.includes("/bodies/") ? "body-version" : "attachment-version",
          }),
        }),
        bucket: "agent-email",
        completeContentCleanup: async (cleanup) => {
          durableCleanup = {
            ...cleanup,
            data: { ...cleanup.data, status: "completed", version: cleanup.data.version + 1 },
          };
        },
        loadContentCleanup: async () => durableCleanup,
        loadDurableMessage: async () => durable,
        now: () => new Date(NOW),
        updateMessage: async (
          _previous,
          updated,
          _event,
          bodyReferences: AgentEmailMessageBodyReferenceUpdate,
          _attachments,
          cleanup,
        ) => {
          const references = {
            ...(bodyReferences.htmlBodyRef ? { htmlBodyRef: bodyReferences.htmlBodyRef } : {}),
            ...(previous.data.rawReference ? { rawReference: previous.data.rawReference } : {}),
            ...(bodyReferences.textBodyRef ? { textBodyRef: bodyReferences.textBodyRef } : {}),
          };
          const committed = inboxMessageRecord(scope, updated, [], references);
          durable = {
            ...committed,
            data: { ...committed.data, version: previous.data.version + 1 },
          };
          durableCleanup = inboxContentCleanupRecord(scope, cleanup);
          throw new Error("DynamoDB response timed out");
        },
      }),
    ).resolves.toBe("reprocessed");
    expect(deleted).toEqual([]);
  });

  it("retries durable superseded-content cleanup without reprocessing the message again", async () => {
    const base = previousMessage();
    const previous = inboxMessageRecord(
      scope,
      {
        ...base.data,
        attachments: [],
        organizationId: ORGANIZATION_ID,
        textBody: undefined,
      } as unknown as AgentEmailMessageRecord,
      [],
      {
        rawReference: base.data.rawReference,
        textBodyRef: {
          bucket: "agent-email",
          byteSize: 13,
          contentType: "text/plain",
          key: "bodies/old-text",
          sha256: "old-text-sha",
          versionId: "old-text-version",
        },
      },
    );
    let cleanup:
      | Extract<PlatformRecord, { readonly itemType: "inbox-content-cleanup" }>
      | undefined;
    let deleteAttempts = 0;
    let putCount = 0;
    let updateCount = 0;
    const dependencies = {
      blobs: blobStore({
        delete: async (key) => {
          if (key !== "bodies/old-text") return;
          deleteAttempts += 1;
          if (deleteAttempts === 1) throw new Error("temporary S3 delete failure");
        },
        put: async ({ key }) => {
          putCount += 1;
          return {
            created: true,
            versionId: key.includes("/bodies/") ? "body-version" : "attachment-version",
          };
        },
      }),
      bucket: "agent-email",
      completeContentCleanup: async (previousCleanup) => {
        cleanup = {
          ...previousCleanup,
          data: {
            ...previousCleanup.data,
            status: "completed",
            version: previousCleanup.data.version + 1,
          },
        };
      },
      loadContentCleanup: async () => cleanup,
      loadDurableMessage: async () => previous,
      now: () => new Date(NOW),
      updateMessage: async (
        _previous,
        _updated,
        _event,
        _bodyReferences,
        _attachments,
        durableCleanup,
      ) => {
        updateCount += 1;
        cleanup = inboxContentCleanupRecord(scope, durableCleanup);
      },
    } satisfies Parameters<typeof persistAgentEmailReprocess>[4];

    expect(
      persistAgentEmailReprocess(command, previous, [], parsedMessage(), dependencies),
    ).rejects.toThrow("temporary S3 delete failure");
    expect(cleanup?.data.status).toBe("pending");
    const uploadsAfterCommit = putCount;

    expect(
      persistAgentEmailReprocess(command, previous, [], parsedMessage(), dependencies),
    ).resolves.toBe("reprocessed");
    expect(cleanup?.data.status).toBe("completed");
    expect(deleteAttempts).toBe(2);
    expect(putCount).toBe(uploadsAfterCommit);
    expect(updateCount).toBe(1);
  });
});
