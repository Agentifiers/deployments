import {
  agentEmailCursor,
  parseAgentEmailCursor,
  type AgentEmailMessageRecord,
  type AgentEmailPolicyRecord,
  type AgentEmailSuppressionRecord,
  type AgentEmailThreadRecord,
  type AgentEmailUsageExportRecord,
} from "@deployments-ai/agent-email";
import {
  CreateAgentEmailSuppressionRequest,
  ExportAgentEmailUsageRequest,
  SearchAgentEmailThreadsRequest,
  UpdateAgentEmailPolicyRequest,
} from "@deployments-ai/api-contract/agent-email";
import { type AgentEmailApiInvocation, type AgentEmailApiOperation } from "./api-handler.ts";

import {
  AGENT_EMAIL_ROUTE_UNHANDLED,
  type AgentEmailApplicationOperations,
} from "./application-route-operations.ts";
import {
  agentEmailCsvCell,
  agentEmailThreadSearchCursor,
  apiError,
  decodePublicRequest,
  domainFrom,
  indexedPage,
  MAX_SEARCH_BODY_BYTES,
  MAX_SEARCH_MESSAGES,
  messageFrom,
  parseAgentEmailThreadSearchCursor,
  placementFrom,
  policyFrom,
  queryLimit,
  queryString,
  requiredBody,
  requiredParameter,
  suppressionFrom,
  THREAD_SEARCH_MESSAGE_PAGE_SIZE,
  threadFrom,
  validated,
  type AgentEmailCursorPosition,
  type RecordOf,
} from "./application-service-support.ts";

export async function executeAgentEmailAdministrationRoute(
  operation: AgentEmailApiOperation,
  invocation: AgentEmailApiInvocation,
  service: AgentEmailApplicationOperations,
): Promise<unknown> {
  const {
    createDomain,
    createDraft,
    createId,
    createPlacement,
    defaultPolicy,
    dependencies,
    getUsageRange,
    mutateDomain,
    now,
    requireDomain,
    requireDraft,
    requireInbox,
    scoped,
    sendDraft,
    transitionDraft,
    updateDraft,
    updatePlacement,
    usageRows,
    validateUsageRange,
  } = service;
  const selected = scoped(invocation);
  switch (operation) {
    case "searchInboxThreads": {
      const inbox = await requireInbox(invocation);
      const input = decodePublicRequest(SearchAgentEmailThreadsRequest, requiredBody(invocation));
      const cursor = validated(() => parseAgentEmailThreadSearchCursor(input.cursor));
      if (cursor) {
        const cursorRecord = await selected.repository.getThread(inbox.id, cursor.thread.id);
        if (!cursorRecord || cursorRecord.data.createdAt !== cursor.thread.createdAt) {
          apiError(400, "invalid_cursor", "The cursor is no longer valid.");
        }
        if (cursor.kind === "within-thread" && cursor.message) {
          const cursorMessage = await selected.repository.getMessage(inbox.id, cursor.message.id);
          if (
            !cursorMessage ||
            cursorMessage.data.threadId !== cursor.thread.id ||
            cursorMessage.data.createdAt !== cursor.message.createdAt
          ) {
            apiError(400, "invalid_cursor", "The cursor is no longer valid.");
          }
        }
      }
      const query = input.query?.toLowerCase();
      const budget = { bodyBytes: 0, messages: 0 };

      async function threadMatches(
        thread: AgentEmailThreadRecord,
        messageCursor?: { readonly createdAt: string; readonly id: string },
      ): Promise<
        | { readonly complete: true; readonly matched: boolean }
        | {
            readonly complete: false;
            readonly matched: false;
            readonly messageCursor?: AgentEmailCursorPosition;
          }
      > {
        if (
          input.participants &&
          !input.participants.every((participant) => thread.participants.includes(participant))
        ) {
          return { complete: true, matched: false };
        }
        const threadSubjectMatches = query ? thread.subject.toLowerCase().includes(query) : false;
        const needsMessage =
          input.from !== undefined ||
          input.to !== undefined ||
          input.hasAttachments !== undefined ||
          (query !== undefined && !threadSubjectMatches);
        if (!needsMessage) return { complete: true, matched: true };
        let currentCursor = messageCursor;
        while (budget.messages < MAX_SEARCH_MESSAGES) {
          const messagePage = await selected.repository.listThreadMessagesPage(
            inbox.id,
            thread.id,
            {
              ...(currentCursor ? { cursor: currentCursor } : {}),
              limit: Math.min(
                THREAD_SEARCH_MESSAGE_PAGE_SIZE,
                MAX_SEARCH_MESSAGES - budget.messages,
              ),
            },
          );
          if (messagePage.items.length === 0 && messagePage.hasMore) {
            throw new Error("Thread search message pagination did not advance.");
          }
          for (const record of messagePage.items) {
            const messageSubjectMatches =
              query !== undefined && record.data.subject.toLowerCase().includes(query);
            const needsBody =
              query !== undefined && !threadSubjectMatches && !messageSubjectMatches;
            const externalBodyBytes = needsBody
              ? (record.data.htmlBodyRef?.byteSize ?? 0) + (record.data.textBodyRef?.byteSize ?? 0)
              : 0;
            if (
              budget.bodyBytes > 0 &&
              budget.bodyBytes + externalBodyBytes > MAX_SEARCH_BODY_BYTES
            ) {
              return {
                complete: false,
                matched: false,
                ...(currentCursor ? { messageCursor: currentCursor } : {}),
              };
            }
            const message: AgentEmailMessageRecord = needsBody
              ? await selected.hydrateMessage(record)
              : await selected.summarizeMessage(record);
            budget.bodyBytes += externalBodyBytes;
            budget.messages += 1;
            currentCursor = {
              createdAt: record.data.createdAt,
              id: record.data.id,
            };
            if (
              (!input.from || message.fromAddress === input.from) &&
              (!input.to || message.toAddresses.includes(input.to)) &&
              (input.hasAttachments === undefined ||
                message.attachments.length > 0 === input.hasAttachments) &&
              (!query ||
                threadSubjectMatches ||
                messageSubjectMatches ||
                message.textBody?.toLowerCase().includes(query) ||
                message.htmlBody?.toLowerCase().includes(query))
            ) {
              return { complete: true, matched: true };
            }
          }
          if (!messagePage.hasMore) return { complete: true, matched: false };
        }
        return {
          complete: false,
          matched: false,
          ...(currentCursor ? { messageCursor: currentCursor } : {}),
        };
      }

      if (cursor?.kind === "within-thread") {
        const current = await selected.repository.getThread(inbox.id, cursor.thread.id);
        if (!current) apiError(400, "invalid_cursor", "The cursor is no longer valid.");
        const thread = threadFrom(current);
        const match = await threadMatches(thread, cursor.message);
        return {
          items: match.complete && match.matched ? [thread] : [],
          ...(!match.complete
            ? {
                nextCursor: agentEmailThreadSearchCursor(
                  cursor.thread,
                  match.messageCursor,
                  cursor.hasFollowing,
                ),
              }
            : cursor.hasFollowing
              ? {
                  nextCursor: agentEmailCursor(cursor.thread.createdAt, cursor.thread.id),
                }
              : {}),
        };
      }

      const result = await selected.repository.listThreadsPage(inbox.id, {
        ...(cursor ? { cursor: cursor.thread } : {}),
        limit: input.limit ?? 50,
      });
      const threads = result.items.map(threadFrom);
      const matches: AgentEmailThreadRecord[] = [];
      for (const [index, thread] of threads.entries()) {
        // eslint-disable-next-line no-await-in-loop -- Search work is globally bounded per request.
        const match = await threadMatches(thread);
        if (!match.complete) {
          return {
            items: matches,
            nextCursor: agentEmailThreadSearchCursor(
              { createdAt: thread.createdAt, id: thread.id },
              match.messageCursor,
              index < threads.length - 1 || result.hasMore,
            ),
          };
        }
        if (match.matched) matches.push(thread);
      }
      return {
        items: matches,
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
    case "getInboxThread": {
      const inbox = await requireInbox(invocation);
      const threadId = requiredParameter(invocation, "threadId");
      const value = await selected.repository.getThread(inbox.id, threadId);
      if (!value) apiError(404, "thread_not_found", `Thread ${threadId} was not found.`);
      const cursor = validated(() => parseAgentEmailCursor(queryString(invocation, "cursor")));
      if (cursor) {
        const cursorRecord = await selected.repository.getMessage(inbox.id, cursor.id);
        if (
          !cursorRecord ||
          cursorRecord.data.threadId !== threadId ||
          cursorRecord.data.createdAt !== cursor.createdAt
        ) {
          apiError(400, "invalid_cursor", "The cursor is no longer valid.");
        }
      }
      const result = await selected.repository.listThreadMessagesPage(inbox.id, threadId, {
        ...(cursor ? { cursor } : {}),
        limit: queryLimit(invocation),
      });
      const messages = await Promise.all(result.items.map(selected.summarizeMessage));
      return {
        messages,
        ...(result.hasMore && result.scannedThrough
          ? {
              nextCursor: agentEmailCursor(
                result.scannedThrough.data.createdAt,
                result.scannedThrough.data.id,
              ),
            }
          : {}),
        thread: threadFrom(value),
      };
    }
    case "createDomain":
      return createDomain(invocation);
    case "listDomains": {
      const cursor = validated(() => parseAgentEmailCursor(queryString(invocation, "cursor")));
      if (cursor) {
        const cursorRecord = await selected.record("inbox-domain", cursor.id);
        if (!cursorRecord || cursorRecord.data.createdAt !== cursor.createdAt) {
          apiError(400, "invalid_cursor", "The cursor is no longer valid.");
        }
      }
      const result = await selected.repository.listDomainsPage({
        ...(cursor ? { cursor } : {}),
        limit: queryLimit(invocation),
      });
      return indexedPage(result.items.map(domainFrom), result);
    }
    case "getDomain":
      return requireDomain(invocation);
    case "refreshDomain":
      return mutateDomain(invocation, "refresh");
    case "revokeDomain":
      return mutateDomain(invocation, "revoke");
    case "createPlacement":
      return createPlacement(invocation);
    case "listPlacements": {
      const cursor = validated(() => parseAgentEmailCursor(queryString(invocation, "cursor")));
      if (cursor) {
        const cursorRecord = await selected.record("inbox-placement", cursor.id);
        if (!cursorRecord || cursorRecord.data.createdAt !== cursor.createdAt) {
          apiError(400, "invalid_cursor", "The cursor is no longer valid.");
        }
      }
      const result = await selected.repository.listPlacementsPage({
        ...(cursor ? { cursor } : {}),
        limit: queryLimit(invocation),
      });
      return indexedPage(result.items.map(placementFrom), result);
    }
    case "getPlacement": {
      const placementId = requiredParameter(invocation, "placementId");
      const value = await selected.record("inbox-placement", placementId);
      if (!value) apiError(404, "placement_not_found", `Placement ${placementId} was not found.`);
      return placementFrom(value);
    }
    case "updatePlacement":
      return updatePlacement(invocation);
    case "createDraft":
      return createDraft(invocation);
    case "listInboxDrafts": {
      const inbox = await requireInbox(invocation);
      const status = queryString(invocation, "status");
      if (
        status &&
        ![
          "approved",
          "cancelled",
          "draft",
          "failed",
          "pending_approval",
          "queued",
          "rejected",
          "scheduled",
          "sent",
        ].includes(status)
      ) {
        apiError(400, "invalid_query", "status is not a valid draft status.");
      }
      const cursor = validated(() => parseAgentEmailCursor(queryString(invocation, "cursor")));
      if (cursor) {
        const cursorRecord = await selected.repository.getDraft(inbox.id, cursor.id);
        if (!cursorRecord || cursorRecord.data.createdAt !== cursor.createdAt) {
          apiError(400, "invalid_cursor", "The cursor is no longer valid.");
        }
      }
      const result = await selected.repository.listDraftsPage(inbox.id, {
        ...(cursor ? { cursor } : {}),
        limit: queryLimit(invocation),
      });
      return indexedPage(
        await Promise.all(
          result.items
            .filter((value) => !status || value.data.status === status)
            .map(selected.summarizeDraft),
        ),
        result,
      );
    }
    case "getDraft":
      return requireDraft(invocation, true);
    case "updateDraft":
      return updateDraft(invocation);
    case "submitDraft":
      return transitionDraft(invocation, "submit");
    case "approveDraft":
      return transitionDraft(invocation, "approve");
    case "rejectDraft":
      return transitionDraft(invocation, "reject");
    case "cancelDraft":
      return transitionDraft(invocation, "cancel");
    case "sendDraft":
      return sendDraft(invocation);
    case "getUsage": {
      const range = getUsageRange(invocation);
      const rows = await usageRows(invocation, {
        bucket: "month",
        from: range.from,
        ...(range.inboxId ? { inboxId: range.inboxId } : {}),
        to: range.to,
      });
      const total = (kind: AgentEmailUsageExportRecord["kind"]) =>
        rows.filter((row) => row.kind === kind).reduce((sum, row) => sum + row.quantity, 0);
      return {
        attachmentBytes: total("attachment_bytes"),
        from: range.from,
        inboundMessages: total("inbound_message"),
        organizationId: invocation.scope.organizationId,
        outboundMessages: total("outbound_message"),
        storedBytes: total("stored_bytes"),
        to: range.to,
      };
    }
    case "exportUsage": {
      const input = decodePublicRequest(ExportAgentEmailUsageRequest, invocation.body ?? {});
      const to = input.to ?? now();
      const from =
        input.from ?? new Date(new Date(to).getTime() - 30 * 24 * 60 * 60 * 1_000).toISOString();
      const range = validateUsageRange(from, to);
      const bucket = input.bucket ?? "day";
      const format = input.format ?? "json";
      const rows = await usageRows(invocation, {
        bucket,
        from: range.from,
        ...(input.inboxId ? { inboxId: input.inboxId } : {}),
        to: range.to,
      });
      const csv =
        format === "csv"
          ? [
              "bucketStart,clientId,inboxId,kind,organizationId,quantity",
              ...rows.map((row) =>
                [
                  row.bucketStart,
                  row.clientId ?? "",
                  row.inboxId ?? "",
                  row.kind,
                  row.organizationId,
                  row.quantity,
                ]
                  .map(agentEmailCsvCell)
                  .join(","),
              ),
            ].join("\n")
          : undefined;
      return {
        bucket,
        ...(csv ? { csv } : {}),
        format,
        from: range.from,
        rows,
        to: range.to,
      };
    }
    case "getPolicy": {
      const value = (await selected.records("inbox-policy")).find((record) => !record.data.inboxId);
      if (!value) apiError(404, "policy_not_found", "The environment email policy was not found.");
      return policyFrom(value);
    }
    case "updatePolicy": {
      const input = decodePublicRequest(UpdateAgentEmailPolicyRequest, requiredBody(invocation));
      const previous = (await selected.records("inbox-policy")).find(
        (record) => !record.data.inboxId,
      );
      const timestamp = now();
      const existing: AgentEmailPolicyRecord = previous
        ? policyFrom(previous)
        : defaultPolicy(invocation, timestamp);
      const {
        sendingStatusReason: previousSendingStatusReason,
        ...existingWithoutSendingStatusReason
      } = existing;
      const updated: AgentEmailPolicyRecord = {
        ...existingWithoutSendingStatusReason,
        allowlist: input.allowlist ?? existing.allowlist ?? [],
        blocklist: input.blocklist ?? existing.blocklist ?? [],
        bounceRateThresholdBasisPoints:
          input.bounceRateThresholdBasisPoints ?? existing.bounceRateThresholdBasisPoints,
        complaintRateThresholdBasisPoints:
          input.complaintRateThresholdBasisPoints ?? existing.complaintRateThresholdBasisPoints,
        dailyOutboundMessageLimit:
          input.dailyOutboundMessageLimit ?? existing.dailyOutboundMessageLimit,
        maxAttachmentBytes: input.maxAttachmentBytes ?? existing.maxAttachmentBytes,
        maxRecipientsPerMessage: input.maxRecipientsPerMessage ?? existing.maxRecipientsPerMessage,
        rawRetentionDays: input.rawRetentionDays ?? existing.rawRetentionDays,
        sendingStatus: input.sendingStatus ?? existing.sendingStatus,
        ...(input.sendingStatus !== "active" && previousSendingStatusReason
          ? { sendingStatusReason: previousSendingStatusReason }
          : {}),
        updatedAt: timestamp,
        warmupStage: input.warmupStage ?? existing.warmupStage,
        ...(input.warmupStage && input.warmupStage !== existing.warmupStage
          ? { warmupStartedAt: timestamp }
          : existing.warmupStartedAt
            ? { warmupStartedAt: existing.warmupStartedAt }
            : {}),
      };
      return policyFrom((await selected.repository.putPolicy(updated)) as RecordOf<"inbox-policy">);
    }
    case "createSuppression": {
      const input = decodePublicRequest(
        CreateAgentEmailSuppressionRequest,
        requiredBody(invocation),
      );
      const address = input.address.toLowerCase();
      if (
        (await selected.repository.listSuppressions()).some(
          (candidate) => candidate.data.status === "active" && candidate.data.address === address,
        )
      ) {
        apiError(409, "suppression_conflict", "The email address is already suppressed.");
      }
      const suppression: AgentEmailSuppressionRecord = {
        address,
        createdAt: now(),
        id: await createId(),
        organizationId: invocation.scope.organizationId,
        reason: input.reason,
      };
      return suppressionFrom(await selected.repository.createSuppression(suppression));
    }
    case "listSuppressions": {
      const cursor = validated(() => parseAgentEmailCursor(queryString(invocation, "cursor")));
      if (cursor) {
        const cursorRecord = await selected.record("inbox-suppression", cursor.id);
        if (!cursorRecord || cursorRecord.data.createdAt !== cursor.createdAt) {
          apiError(400, "invalid_cursor", "The cursor is no longer valid.");
        }
      }
      const result = await selected.repository.listSuppressionsPage({
        ...(cursor ? { cursor } : {}),
        limit: queryLimit(invocation),
      });
      return indexedPage(
        result.items.filter((record) => record.data.status === "active").map(suppressionFrom),
        result,
      );
    }
    case "removeSuppression": {
      const suppressionId = requiredParameter(invocation, "suppressionId");
      const value = await selected.record("inbox-suppression", suppressionId);
      if (!value) {
        apiError(404, "suppression_not_found", `Suppression ${suppressionId} was not found.`);
      }
      const response = suppressionFrom(value);
      if (value.data.status === "active" && response.sourceMessageId) {
        const source = await selected.record("inbox-message", response.sourceMessageId);
        if (!source) {
          apiError(
            409,
            "suppression_source_not_found",
            "The provider suppression source message is no longer available.",
          );
        }
        if (!dependencies.syncProviderSuppression) {
          apiError(
            503,
            "suppression_provider_unavailable",
            "Provider suppression operations are not configured.",
          );
        }
        await dependencies.syncProviderSuppression({
          message: messageFrom(source, []),
          removed: true,
          scope: invocation.scope,
          suppression: response,
        });
      }
      if (!(await selected.repository.removeSuppression(suppressionId, now()))) {
        apiError(404, "suppression_not_found", `Suppression ${suppressionId} was not found.`);
      }
      return response;
    }
    default:
      return AGENT_EMAIL_ROUTE_UNHANDLED;
  }
}
