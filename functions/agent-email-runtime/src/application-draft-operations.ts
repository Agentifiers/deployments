import {
  agentEmailTenantObjectPrefix,
  type AgentEmailAttachmentRecord,
  type AgentEmailDraftRecord,
} from "@deployments-ai/agent-email";
import { deterministicAgentEmailUlid } from "@deployments-ai/agent-email/aws";
import {
  CreateAgentEmailDraftRequest,
  RejectAgentEmailDraftRequest,
  UpdateAgentEmailDraftRequest,
} from "@deployments-ai/api-contract/agent-email";
import {
  inboxDraftRecord,
  type AgentEmailAttachmentBlob,
  type AgentEmailDraftBodyReferenceUpdate,
  type AgentEmailMessageBodyReferences,
  type PlatformRecord,
  type Ulid,
  agentEmailPersistence,
} from "@deployments-ai/db";
import { Equal } from "effect";
import { createHash } from "node:crypto";
import { type AgentEmailApiInvocation } from "./api-handler.ts";

import type { AgentEmailApplicationContext } from "./application-service-context.ts";
import {
  apiError,
  decodePublicRequest,
  requiredBody,
  type RecordOf,
} from "./application-service-support.ts";

export function createAgentEmailDraftOperations(context: AgentEmailApplicationContext) {
  const { createId, dependencies, now, requireDraft, requireInbox, scoped } = context;
  async function createDraft(invocation: AgentEmailApiInvocation) {
    const input = decodePublicRequest(CreateAgentEmailDraftRequest, requiredBody(invocation));
    const inbox = await requireInbox(invocation);
    const timestamp = now();
    const draftRecord: AgentEmailDraftRecord = {
      bccAddresses: input.bcc ?? [],
      ccAddresses: input.cc ?? [],
      ...(input.clientId ? { clientId: input.clientId } : {}),
      createdAt: timestamp,
      ...(input.html !== undefined ? { htmlBody: input.html } : {}),
      id: await createId(),
      inboxId: inbox.id,
      metadata: input.metadata ?? {},
      organizationId: invocation.scope.organizationId,
      ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
      ...(input.scheduledAt ? { scheduledAt: input.scheduledAt } : {}),
      status: "draft",
      subject: input.subject,
      ...(input.text !== undefined ? { textBody: input.text } : {}),
      toAddresses: input.to,
      updatedAt: timestamp,
    };
    return persistDraft(invocation, draftRecord);
  }

  async function updateDraft(invocation: AgentEmailApiInvocation) {
    const input = decodePublicRequest(UpdateAgentEmailDraftRequest, requiredBody(invocation));
    const existing = await requireDraft(invocation, true);
    if (existing.status !== "draft" && existing.status !== "rejected") {
      apiError(409, "draft_not_editable", "Only draft or rejected drafts can be edited.");
    }
    const {
      failureReason: _previousFailureReason,
      rejectedAt: _previousRejectedAt,
      ...editable
    } = existing;
    const updated: AgentEmailDraftRecord = {
      ...editable,
      bccAddresses: input.bcc ?? existing.bccAddresses,
      ccAddresses: input.cc ?? existing.ccAddresses,
      ...(input.html === undefined ? {} : { htmlBody: input.html }),
      metadata: input.metadata ?? existing.metadata,
      ...(input.scheduledAt === undefined ? {} : { scheduledAt: input.scheduledAt }),
      subject: input.subject ?? existing.subject,
      ...(input.text === undefined ? {} : { textBody: input.text }),
      toAddresses: input.to ?? existing.toAddresses,
      status: "draft",
      updatedAt: now(),
    };
    return persistDraft(invocation, updated);
  }

  async function transitionDraft(
    invocation: AgentEmailApiInvocation,
    operation: "approve" | "cancel" | "reject" | "submit",
  ) {
    const existing = await requireDraft(invocation, true);
    const timestamp = now();
    let changed: AgentEmailDraftRecord;
    if (operation === "submit") {
      if (existing.status !== "draft" && existing.status !== "rejected") {
        apiError(
          409,
          "invalid_draft_transition",
          "Only draft or rejected drafts can be submitted.",
        );
      }
      const {
        approvedAt: _previousApprovedAt,
        failureReason: _previousFailureReason,
        rejectedAt: _previousRejectedAt,
        ...resubmittable
      } = existing;
      changed = {
        ...resubmittable,
        status: "pending_approval",
        updatedAt: timestamp,
      };
    } else if (operation === "approve") {
      if (existing.status !== "pending_approval") {
        apiError(409, "invalid_draft_transition", "Only pending drafts can be approved.");
      }
      changed = {
        ...existing,
        approvedAt: timestamp,
        status: "approved",
        updatedAt: timestamp,
      };
    } else if (operation === "reject") {
      if (existing.status !== "pending_approval") {
        apiError(409, "invalid_draft_transition", "Only pending drafts can be rejected.");
      }
      const input = decodePublicRequest(RejectAgentEmailDraftRequest, requiredBody(invocation));
      changed = {
        ...existing,
        failureReason: input.reason,
        rejectedAt: timestamp,
        status: "rejected",
        updatedAt: timestamp,
      };
    } else {
      if (
        !["approved", "draft", "pending_approval", "rejected", "scheduled"].includes(
          existing.status,
        )
      ) {
        apiError(
          409,
          "invalid_draft_transition",
          "The draft cannot be cancelled in its current state.",
        );
      }
      changed = { ...existing, status: "cancelled", updatedAt: timestamp };
    }
    if (operation === "cancel" && existing.status === "scheduled") {
      if (!existing.sentMessageId) {
        apiError(500, "scheduled_message_missing", "The scheduled draft has no persisted message.");
      }
      const selected = scoped(invocation);
      const [previousDraft, previousMessage] = await Promise.all([
        selected.record("inbox-draft", existing.id),
        selected.record("inbox-message", existing.sentMessageId),
      ]);
      if (!previousDraft || !previousMessage) {
        apiError(
          500,
          "scheduled_message_missing",
          "The scheduled draft's persisted message was not found.",
        );
      }
      if (previousMessage.data.status !== "scheduled") {
        apiError(
          409,
          "scheduled_message_already_sending",
          "The scheduled message can no longer be cancelled.",
        );
      }
      const saved = await selected.repository.cancelScheduledDraft(
        previousDraft,
        changed,
        previousMessage,
      );
      return selected.summarizeDraft(saved);
    }
    return persistDraft(invocation, changed);
  }

  async function rethrowAfterBlobCleanup(
    cause: unknown,
    references: readonly {
      readonly bucket: string;
      readonly key: string;
      readonly versionId?: string;
    }[],
  ): Promise<never> {
    const failures: unknown[] = [];
    for (const reference of references) {
      let lastFailure: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          // eslint-disable-next-line no-await-in-loop -- Cleanup retries each newly created immutable version.
          await dependencies.blobs?.delete(reference.key, reference.bucket, reference.versionId);
          lastFailure = undefined;
          break;
        } catch (cleanupCause) {
          lastFailure = cleanupCause;
        }
      }
      if (lastFailure) failures.push(lastFailure);
    }
    if (failures.length > 0) {
      throw new AggregateError(
        [cause, ...failures],
        "Agent email blob cleanup failed after an incomplete write.",
      );
    }
    throw cause;
  }

  async function uploadAttachments(
    invocation: AgentEmailApiInvocation,
    messageId: string,
    values:
      | readonly {
          readonly contentBase64: string;
          readonly contentId?: string | undefined;
          readonly contentType: string;
          readonly disposition?: "attachment" | "inline" | undefined;
          readonly fileName: string;
        }[]
      | undefined,
  ) {
    if (!values?.length) return { blobs: [], createdBlobs: [], records: [] };
    if (!dependencies.blobs || !dependencies.blobBucket) {
      apiError(
        503,
        "attachment_storage_unavailable",
        "Outbound attachment storage is not configured.",
      );
    }
    const blobs: AgentEmailAttachmentBlob[] = [];
    const records: AgentEmailAttachmentRecord[] = [];
    const createdBlobs: {
      readonly bucket: string;
      readonly key: string;
      readonly versionId?: string;
    }[] = [];
    try {
      for (const [index, value] of values.entries()) {
        const body = Buffer.from(value.contentBase64, "base64");
        if (
          body.toString("base64").replaceAll("=", "") !== value.contentBase64.replaceAll("=", "")
        ) {
          apiError(400, "invalid_attachment", `Attachment ${index + 1} is not valid base64.`);
        }
        const id = await createId();
        const sha256 = createHash("sha256").update(body).digest("hex");
        const key = `${agentEmailTenantObjectPrefix(invocation.scope)}/outbound/${messageId}/${id}`;
        const stored = await dependencies.blobs.put({
          body,
          contentType: value.contentType,
          ifAbsent: true,
          key,
          metadata: { sha256 },
        });
        const disposition = value.disposition ?? "attachment";
        const blob = {
          bucket: dependencies.blobBucket,
          byteSize: body.byteLength,
          ...(value.contentId ? { contentId: value.contentId } : {}),
          contentType: value.contentType,
          disposition,
          ...(stored?.etag ? { etag: stored.etag } : {}),
          fileName: value.fileName,
          id: id as Ulid,
          key,
          sha256,
          ...(stored?.versionId ? { versionId: stored.versionId } : {}),
        } satisfies AgentEmailAttachmentBlob;
        blobs.push(blob);
        if (stored?.created) {
          createdBlobs.push({
            bucket: blob.bucket,
            key: blob.key,
            ...(blob.versionId ? { versionId: blob.versionId } : {}),
          });
        }
        records.push({
          byteSize: body.byteLength,
          ...(value.contentId ? { contentId: value.contentId } : {}),
          contentType: value.contentType,
          disposition,
          fileName: value.fileName,
          id,
          messageId,
          sha256,
        });
      }
    } catch (cause) {
      await rethrowAfterBlobCleanup(cause, createdBlobs);
    }
    return { blobs, createdBlobs, records };
  }

  async function externalizeBodies(
    invocation: AgentEmailApiInvocation,
    resourceId: string,
    htmlBody: string | undefined,
    textBody: string | undefined,
    existingReferences: Pick<AgentEmailMessageBodyReferences, "htmlBodyRef" | "textBodyRef"> = {},
  ): Promise<{
    readonly bodyReferences: AgentEmailDraftBodyReferenceUpdate & AgentEmailMessageBodyReferences;
    readonly byteSize: number;
    readonly createdBlobs: readonly {
      readonly bucket: string;
      readonly key: string;
      readonly versionId?: string;
    }[];
    readonly htmlBody?: string;
    readonly textBody?: string;
  }> {
    const htmlBytes = htmlBody === undefined ? undefined : Buffer.from(htmlBody, "utf8");
    const textBytes = textBody === undefined ? undefined : Buffer.from(textBody, "utf8");
    const byteSize = (htmlBytes?.byteLength ?? 0) + (textBytes?.byteLength ?? 0);
    if (byteSize <= 256 * 1024) {
      return {
        bodyReferences: {},
        byteSize,
        createdBlobs: [],
        ...(htmlBody === undefined ? {} : { htmlBody }),
        ...(textBody === undefined ? {} : { textBody }),
      };
    }
    const blobStore = dependencies.blobs;
    const blobBucket = dependencies.blobBucket;
    if (!blobStore || !blobBucket) {
      apiError(503, "body_storage_unavailable", "Large email body storage is not configured.");
    }

    const createdBlobs: {
      readonly bucket: string;
      readonly key: string;
      readonly versionId?: string;
    }[] = [];
    const put = async (
      body: Uint8Array | undefined,
      suffix: "body.html" | "body.txt",
      contentType: string,
      existing: AgentEmailMessageBodyReferences["htmlBodyRef"],
    ) => {
      if (!body) return undefined;
      const sha256 = createHash("sha256").update(body).digest("hex");
      if (
        existing?.sha256 === sha256 &&
        existing.byteSize === body.byteLength &&
        existing.contentType === contentType
      ) {
        return existing;
      }
      const key = `${agentEmailTenantObjectPrefix(invocation.scope)}/outbound-bodies/${resourceId}/${sha256}/${suffix}`;
      const stored = await blobStore.put({
        body,
        contentType,
        ifAbsent: true,
        key,
        metadata: { sha256 },
      });
      const reference = {
        bucket: blobBucket,
        byteSize: body.byteLength,
        contentType,
        ...(stored?.etag ? { etag: stored.etag } : {}),
        key,
        sha256,
        ...(stored?.versionId ? { versionId: stored.versionId } : {}),
      };
      if (stored?.created) {
        createdBlobs.push({
          bucket: reference.bucket,
          key: reference.key,
          ...(reference.versionId ? { versionId: reference.versionId } : {}),
        });
      }
      return reference;
    };
    let htmlBodyRef;
    let textBodyRef;
    try {
      htmlBodyRef = await put(
        htmlBytes,
        "body.html",
        "text/html; charset=utf-8",
        existingReferences.htmlBodyRef,
      );
      textBodyRef = await put(
        textBytes,
        "body.txt",
        "text/plain; charset=utf-8",
        existingReferences.textBodyRef,
      );
    } catch (cause) {
      await rethrowAfterBlobCleanup(cause, createdBlobs);
    }
    return {
      bodyReferences: {
        ...(htmlBodyRef ? { htmlBodyRef } : {}),
        ...(textBodyRef ? { textBodyRef } : {}),
      },
      byteSize,
      createdBlobs,
    };
  }

  async function persistDraft(invocation: AgentEmailApiInvocation, draft: AgentEmailDraftRecord) {
    const selected = scoped(invocation);
    const previous = await selected.record("inbox-draft", draft.id);
    const cleanupId = previous
      ? deterministicAgentEmailUlid(
          draft.createdAt,
          "draft-content-cleanup-v1",
          invocation.scope.organizationId,
          invocation.scope.projectId,
          invocation.scope.environmentId,
          draft.id,
          invocation.identity.principalId,
          invocation.idempotencyKey ??
            createHash("sha256").update(JSON.stringify(draft)).digest("hex"),
        )
      : undefined;
    const finishCleanup = async (cleanup: RecordOf<"inbox-content-cleanup">): Promise<void> => {
      if (cleanup.data.status === "completed") return;
      if (cleanup.data.references.length > 0 && !dependencies.blobs) {
        apiError(503, "blob_cleanup_unavailable", "Draft body cleanup storage is not configured.");
      }
      await Promise.all(
        cleanup.data.references.map((reference) =>
          dependencies.blobs!.delete(reference.key, reference.bucket, reference.versionId),
        ),
      );
      await selected.repository.completeContentCleanup(cleanup, now());
    };
    if (cleanupId && previous) {
      const existingCleanup = await selected.repository.getContentCleanup(draft.id, cleanupId);
      if (existingCleanup) {
        await finishCleanup(existingCleanup);
        return selected.summarizeDraft(previous);
      }
    }
    const bodies = await externalizeBodies(
      invocation,
      cleanupId ? `${draft.id}/${cleanupId}` : draft.id,
      draft.htmlBody,
      draft.textBody,
      previous
        ? {
            ...(previous.data.htmlBodyRef ? { htmlBodyRef: previous.data.htmlBodyRef } : {}),
            ...(previous.data.textBodyRef ? { textBodyRef: previous.data.textBodyRef } : {}),
          }
        : undefined,
    );
    const { htmlBody: _htmlBody, textBody: _textBody, ...draftWithoutBodies } = draft;
    const persistedDraft = {
      ...draftWithoutBodies,
      ...("htmlBody" in bodies ? { htmlBody: bodies.htmlBody } : {}),
      ...("textBody" in bodies ? { textBody: bodies.textBody } : {}),
    };
    const expectedBase = inboxDraftRecord(
      selected.scope,
      persistedDraft,
      [],
      bodies.bodyReferences,
    );
    const expected = previous
      ? {
          ...expectedBase,
          data: {
            ...expectedBase.data,
            version: previous.data.version + 1,
          },
        }
      : expectedBase;
    const currentReferences = new Set(
      [bodies.bodyReferences.htmlBodyRef, bodies.bodyReferences.textBodyRef]
        .filter((reference) => reference !== undefined)
        .map(
          (reference) =>
            `${reference.bucket}\u0000${reference.key}\u0000${reference.versionId ?? ""}`,
        ),
    );
    const previousReferences = [previous?.data.htmlBodyRef, previous?.data.textBodyRef];
    const superseded = previousReferences.filter(
      (reference): reference is Exclude<(typeof previousReferences)[number], undefined> =>
        reference !== undefined &&
        !currentReferences.has(
          `${reference.bucket}\u0000${reference.key}\u0000${reference.versionId ?? ""}`,
        ),
    );
    const cleanup =
      previous && cleanupId
        ? {
            createdAt: draft.updatedAt,
            id: cleanupId as Ulid,
            references: superseded,
            resourceId: draft.id as Ulid,
            resourceType: "draft" as const,
          }
        : undefined;
    let saved!: RecordOf<"inbox-draft">;
    try {
      saved = await selected.repository.putDraft(persistedDraft, bodies.bodyReferences, cleanup);
    } catch (cause) {
      let committed: PlatformRecord | undefined;
      try {
        committed = await agentEmailPersistence.read(
          dependencies.database,
          "execution",
          {
            pk: expected.pk,
            sk: expected.sk,
          },
          true,
        );
      } catch (reconciliationCause) {
        throw new AggregateError(
          [cause, reconciliationCause],
          "Agent email draft persistence outcome could not be reconciled.",
        );
      }
      if (
        committed?.itemType === "inbox-draft" &&
        Equal.equals(committed, {
          ...expected,
          data: { ...expected.data, participantKeys: committed.data.participantKeys },
        })
      ) {
        saved = committed;
      } else {
        await rethrowAfterBlobCleanup(cause, bodies.createdBlobs);
      }
    }
    if (cleanup) {
      const durableCleanup = await selected.repository.getContentCleanup(draft.id, cleanup.id);
      if (!durableCleanup) {
        throw new Error("Committed draft body cleanup work is missing.");
      }
      await finishCleanup(durableCleanup);
    }
    return selected.summarizeDraft(saved);
  }

  return {
    createDraft,
    externalizeBodies,
    persistDraft,
    rethrowAfterBlobCleanup,
    transitionDraft,
    uploadAttachments,
    updateDraft,
  };
}
