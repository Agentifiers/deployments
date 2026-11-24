import {
  agentEmailCursor,
  parseAgentEmailCursor,
  type AgentEmailMessageRecord,
} from "@deployments-ai/agent-email";
import { SearchAgentEmailMessagesRequest } from "@deployments-ai/api-contract/agent-email";
import { createHash } from "node:crypto";
import { type AgentEmailApiInvocation, type AgentEmailApiOperation } from "./api-handler.ts";

import {
  AGENT_EMAIL_ROUTE_UNHANDLED,
  type AgentEmailApplicationOperations,
} from "./application-route-operations.ts";
import {
  apiError,
  bindingFrom,
  decodePublicRequest,
  inboxFrom,
  indexedPage,
  MAX_SEARCH_BODY_BYTES,
  MAX_SEARCH_MESSAGES,
  queryLimit,
  queryString,
  requiredBody,
  requiredParameter,
  threadFrom,
  validated,
  type AgentEmailCursorPosition,
} from "./application-service-support.ts";

export async function executeAgentEmailInboxRoute(
  operation: AgentEmailApiOperation,
  invocation: AgentEmailApiInvocation,
  service: AgentEmailApplicationOperations,
): Promise<unknown> {
  const {
    createBinding,
    createInbox,
    deleteBinding,
    dependencies,
    now,
    replyOrForward,
    requireInbox,
    requireMessage,
    scoped,
    sendInboxMessage,
    updateInbox,
  } = service;
  const selected = scoped(invocation);
  switch (operation) {
    case "createInbox":
      return createInbox(invocation);
    case "listInboxes": {
      const status = queryString(invocation, "status");
      if (status && !["active", "archived", "paused"].includes(status)) {
        apiError(400, "invalid_query", "status is not a valid inbox status.");
      }
      const clientId = queryString(invocation, "clientId");
      const cursor = validated(() => parseAgentEmailCursor(queryString(invocation, "cursor")));
      if (cursor) {
        const cursorRecord = await selected.repository.getInbox(cursor.id);
        if (!cursorRecord || cursorRecord.data.createdAt !== cursor.createdAt) {
          apiError(400, "invalid_cursor", "The cursor is no longer valid.");
        }
      }
      const result = await selected.repository.listInboxesPage({
        ...(cursor ? { cursor } : {}),
        limit: queryLimit(invocation),
      });
      const values = result.items
        .map(inboxFrom)
        .filter(
          (inbox) =>
            (!status || inbox.status === status) && (!clientId || inbox.clientId === clientId),
        );
      return indexedPage(values, result);
    }
    case "getInbox":
      return requireInbox(invocation);
    case "updateInbox":
      return updateInbox(invocation);
    case "createBinding":
      return createBinding(invocation);
    case "listBindings": {
      const inbox = await requireInbox(invocation);
      const cursor = validated(() => parseAgentEmailCursor(queryString(invocation, "cursor")));
      if (cursor) {
        const cursorRecord = await selected.record("inbox-binding", cursor.id);
        if (!cursorRecord || cursorRecord.data.createdAt !== cursor.createdAt) {
          apiError(400, "invalid_cursor", "The cursor is no longer valid.");
        }
      }
      const result = await selected.repository.listInboxBindingsPage({
        ...(cursor ? { cursor } : {}),
        limit: queryLimit(invocation),
      });
      return indexedPage(
        result.items
          .map(bindingFrom)
          .filter((binding) => binding.inboxId === inbox.id && binding.status !== "archived"),
        result,
      );
    }
    case "getBinding": {
      const bindingId = requiredParameter(invocation, "bindingId");
      const value = await selected.record("inbox-binding", bindingId);
      if (!value) apiError(404, "binding_not_found", `Binding ${bindingId} was not found.`);
      return bindingFrom(value);
    }
    case "deleteBinding":
      return deleteBinding(invocation);
    case "sendInboxMessage":
      return sendInboxMessage(invocation);
    case "listInboxMessages": {
      const inbox = await requireInbox(invocation);
      const direction = queryString(invocation, "direction");
      const status = queryString(invocation, "status");
      if (direction && !["inbound", "outbound"].includes(direction)) {
        apiError(400, "invalid_query", "direction must be inbound or outbound.");
      }
      if (
        status &&
        ![
          "accepted",
          "bounced",
          "complained",
          "delivered",
          "failed",
          "queued",
          "received",
          "scheduled",
          "sending",
        ].includes(status)
      ) {
        apiError(400, "invalid_query", "status is not a valid message status.");
      }
      const cursor = validated(() => parseAgentEmailCursor(queryString(invocation, "cursor")));
      if (cursor) {
        const cursorRecord = await selected.repository.getMessage(inbox.id, cursor.id);
        if (!cursorRecord || cursorRecord.data.createdAt !== cursor.createdAt) {
          apiError(400, "invalid_cursor", "The cursor is no longer valid.");
        }
      }
      const result = await selected.repository.listMessagesPage(inbox.id, {
        ...(cursor ? { cursor } : {}),
        limit: queryLimit(invocation),
      });
      const items = await Promise.all(
        result.items
          .filter(
            (value) =>
              (!direction || value.data.direction === direction) &&
              (!status || value.data.status === status),
          )
          .map(selected.summarizeMessage),
      );
      return {
        items,
        ...(result.hasMore && result.scannedThrough
          ? {
              nextCursor: agentEmailCursor(
                result.scannedThrough.data.createdAt,
                result.scannedThrough.data.id,
              ),
            }
          : {}),
      };
    }
    case "searchInboxMessages": {
      const inbox = await requireInbox(invocation);
      const input = decodePublicRequest(SearchAgentEmailMessagesRequest, requiredBody(invocation));
      const cursor = validated(() => parseAgentEmailCursor(input.cursor));
      if (cursor) {
        const cursorRecord = await selected.repository.getMessage(inbox.id, cursor.id);
        if (!cursorRecord || cursorRecord.data.createdAt !== cursor.createdAt) {
          apiError(400, "invalid_cursor", "The cursor is no longer valid.");
        }
      }
      const result = await selected.repository.listMessagesPage(inbox.id, {
        ...(cursor ? { cursor } : {}),
        limit: Math.min(input.limit ?? 50, MAX_SEARCH_MESSAGES),
      });
      const query = input.query?.toLowerCase();
      const items = [];
      let bodyBytes = 0;
      let scannedThrough: AgentEmailCursorPosition | undefined;
      let stoppedEarly = false;
      for (const record of result.items) {
        const metadataMatches =
          (!input.direction || record.data.direction === input.direction) &&
          (!input.status || record.data.status === input.status) &&
          (!input.from || record.data.fromAddress === input.from) &&
          (!input.to || record.data.toAddresses.includes(input.to)) &&
          (!input.participants ||
            input.participants.every((participant) =>
              [
                record.data.fromAddress,
                ...record.data.toAddresses,
                ...record.data.ccAddresses,
                ...record.data.bccAddresses,
              ].includes(participant),
            ));
        if (!metadataMatches) {
          scannedThrough = {
            createdAt: record.data.createdAt,
            id: record.data.id,
          };
          continue;
        }
        const subjectMatches =
          query !== undefined && record.data.subject.toLowerCase().includes(query);
        const needsBody = query !== undefined && !subjectMatches;
        const externalBodyBytes = needsBody
          ? (record.data.htmlBodyRef?.byteSize ?? 0) + (record.data.textBodyRef?.byteSize ?? 0)
          : 0;
        if (bodyBytes > 0 && bodyBytes + externalBodyBytes > MAX_SEARCH_BODY_BYTES) {
          stoppedEarly = true;
          break;
        }
        // eslint-disable-next-line no-await-in-loop -- Search hydration is globally byte-bounded.
        const message: AgentEmailMessageRecord = needsBody
          ? await selected.hydrateMessage(record)
          : await selected.summarizeMessage(record);
        bodyBytes += externalBodyBytes;
        scannedThrough = {
          createdAt: record.data.createdAt,
          id: record.data.id,
        };
        if (
          (input.hasAttachments === undefined ||
            message.attachments.length > 0 === input.hasAttachments) &&
          (!query ||
            subjectMatches ||
            message.textBody?.toLowerCase().includes(query) ||
            message.htmlBody?.toLowerCase().includes(query))
        ) {
          const { htmlBody: _htmlBody, textBody: _textBody, ...summary } = message;
          items.push(summary);
        }
      }
      return {
        items,
        ...((stoppedEarly || result.hasMore) && scannedThrough
          ? {
              nextCursor: agentEmailCursor(scannedThrough.createdAt, scannedThrough.id),
            }
          : {}),
      };
    }
    case "getMessage":
      return requireMessage(invocation, true);
    case "replyMessage":
      return replyOrForward(invocation, "reply");
    case "replyAllMessage":
      return replyOrForward(invocation, "replyAll");
    case "forwardMessage":
      return replyOrForward(invocation, "forward");
    case "createRawMessageAccess": {
      const messageId = requiredParameter(invocation, "messageId");
      const value = await selected.record("inbox-message", messageId);
      if (!value) apiError(404, "message_not_found", `Message ${messageId} was not found.`);
      const accessedAt = now();
      if (
        value.data.rawPurgedAt ||
        !value.data.rawReference ||
        !value.data.rawRetentionExpiresAt ||
        value.data.rawRetentionExpiresAt <= accessedAt
      ) {
        apiError(410, "raw_message_unavailable", "The raw message is no longer available.");
      }
      if (!dependencies.blobs) {
        apiError(503, "blob_access_unavailable", "Message blob access is not configured.");
      }
      const remainingSeconds = Math.floor(
        (Date.parse(value.data.rawRetentionExpiresAt) - Date.parse(accessedAt)) / 1_000,
      );
      if (remainingSeconds < 1) {
        apiError(410, "raw_message_unavailable", "The raw message is no longer available.");
      }
      const ttl = Math.min(dependencies.signedUrlTtlSeconds ?? 300, remainingSeconds);
      return {
        expiresAt: new Date(Date.parse(accessedAt) + ttl * 1_000).toISOString(),
        ...(value.data.rawPurgedAt ? { rawPurgedAt: value.data.rawPurgedAt } : {}),
        ...(value.data.rawRetentionExpiresAt
          ? { rawRetentionExpiresAt: value.data.rawRetentionExpiresAt }
          : {}),
        url: await dependencies.blobs.signedGetUrl(
          value.data.rawReference.key,
          ttl,
          value.data.rawReference.versionId,
          value.data.rawReference.bucket,
        ),
      };
    }
    case "reprocessRawMessage": {
      const messageId = requiredParameter(invocation, "messageId");
      const record = await selected.record("inbox-message", messageId);
      if (!record) apiError(404, "message_not_found", `Message ${messageId} was not found.`);
      const message = await selected.summarizeMessage(record);
      if (
        record.data.direction !== "inbound" ||
        record.data.rawPurgedAt ||
        !record.data.rawReference ||
        !record.data.rawRetentionExpiresAt ||
        record.data.rawRetentionExpiresAt <= now()
      ) {
        apiError(409, "message_not_reprocessable", "The message cannot be reprocessed.");
      }
      if (!dependencies.enqueueReprocess) {
        apiError(503, "reprocess_queue_unavailable", "Raw reprocessing is not configured.");
      }
      const idempotencyKey =
        invocation.idempotencyKey ??
        apiError(
          400,
          "idempotency_key_required",
          "Raw message reprocessing requires an idempotency key.",
        );
      await dependencies.enqueueReprocess({
        message,
        reprocessId: createHash("sha256")
          .update(
            [
              invocation.scope.organizationId,
              invocation.scope.projectId,
              invocation.scope.environmentId,
              message.id,
              idempotencyKey,
            ].join("\u0000"),
          )
          .digest("hex"),
        scope: invocation.scope,
      });
      return message;
    }
    case "createAttachmentAccessUrl": {
      const attachmentId = requiredParameter(invocation, "attachmentId");
      const value = await selected.record("inbox-attachment", attachmentId);
      if (!value) {
        apiError(404, "attachment_not_found", `Attachment ${attachmentId} was not found.`);
      }
      if (!dependencies.blobs) {
        apiError(503, "blob_access_unavailable", "Attachment blob access is not configured.");
      }
      const ttl = dependencies.signedUrlTtlSeconds ?? 300;
      return {
        expiresAt: new Date(new Date(now()).getTime() + ttl * 1_000).toISOString(),
        url: await dependencies.blobs.signedGetUrl(
          value.data.storage.key,
          ttl,
          value.data.storage.versionId,
          value.data.storage.bucket,
        ),
      };
    }
    case "listInboxThreads": {
      const inbox = await requireInbox(invocation);
      const cursor = validated(() => parseAgentEmailCursor(queryString(invocation, "cursor")));
      if (cursor) {
        const cursorRecord = await selected.repository.getThread(inbox.id, cursor.id);
        if (!cursorRecord || cursorRecord.data.createdAt !== cursor.createdAt) {
          apiError(400, "invalid_cursor", "The cursor is no longer valid.");
        }
      }
      const result = await selected.repository.listThreadsPage(inbox.id, {
        ...(cursor ? { cursor } : {}),
        limit: queryLimit(invocation),
      });
      return {
        items: result.items.map(threadFrom),
        ...(result.hasMore && result.scannedThrough
          ? {
              nextCursor: agentEmailCursor(
                result.scannedThrough.data.createdAt,
                result.scannedThrough.data.id,
              ),
            }
          : {}),
      };
    }
    default:
      return AGENT_EMAIL_ROUTE_UNHANDLED;
  }
}
