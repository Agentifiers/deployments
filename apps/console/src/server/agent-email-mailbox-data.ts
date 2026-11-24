import "@tanstack/react-start/server-only";
import type { AgentEmailMessage } from "../email/compose-state.ts";
import type { AgentEmailDraft, DraftStatus } from "../email/draft-lifecycle.ts";
import { MAILBOX_PAGE_SIZE, type MessageSearch } from "../email/mailbox-state.ts";
import { collectPagesUpTo } from "../overview/status-counts.ts";
import type { EnvironmentScope } from "../scope.ts";
import { loadPolicyState } from "./agent-email-setup-data.ts";
import { API_PAGE_LIMIT, fillPage, type Page } from "./list-pages.ts";
import { callRoute, type RouteResponse } from "./platform-api.ts";
import { decodeRequestBody } from "./request-body.ts";

const MAX_INBOX_PAGES = 20;

type AgentEmailThread = RouteResponse<"getAgentEmailThread">["thread"];
type AgentEmailThreadDetail = RouteResponse<"getAgentEmailThread">;

export interface ComposeContext {
  readonly allowlist: readonly string[];
  /** False when the environment has more active inboxes than the console reads. */
  readonly complete: boolean;
  readonly maxAttachmentBytes: number | undefined;
  /** Active inboxes on the sender's domain: the runtime delivers to them without warmup checks. */
  readonly ownInboxes: readonly string[];
}

export function loadThreadPage(
  accessToken: string,
  scope: EnvironmentScope,
  {
    cursor,
    inboxId,
    q,
  }: {
    readonly cursor: string | undefined;
    readonly inboxId: string;
    readonly q: string | undefined;
  },
): Promise<Page<AgentEmailThread>> {
  if (q === undefined) {
    return callRoute(
      "listAgentEmailThreads",
      { path: { inboxId }, query: { cursor, limit: MAILBOX_PAGE_SIZE }, scope },
      accessToken,
    );
  }
  return callRoute(
    "searchAgentEmailThreads",
    {
      body: decodeRequestBody("searchAgentEmailThreads", "SearchAgentEmailThreadsRequest", {
        ...(cursor === undefined ? {} : { cursor }),
        limit: MAILBOX_PAGE_SIZE,
        query: q,
      }),
      path: { inboxId },
      scope,
    },
    accessToken,
  );
}

export function loadThread(
  accessToken: string,
  scope: EnvironmentScope,
  {
    cursor,
    inboxId,
    threadId,
  }: { readonly cursor: string | undefined; readonly inboxId: string; readonly threadId: string },
): Promise<AgentEmailThreadDetail> {
  return callRoute(
    "getAgentEmailThread",
    { path: { inboxId, threadId }, query: { cursor, limit: MAILBOX_PAGE_SIZE }, scope },
    accessToken,
  );
}

type MessageSummary = Omit<AgentEmailMessage, "htmlBody" | "textBody">;

/**
 * The runtime filters messages by direction and status after paging, so short pages are filled.
 * A search reads up to 16 MiB of bodies per call, so it makes one call per page instead.
 */
export function loadMessagePage(
  accessToken: string,
  scope: EnvironmentScope,
  {
    cursor,
    inboxId,
    search: { direction, q, status },
  }: {
    readonly cursor: string | undefined;
    readonly inboxId: string;
    readonly search: MessageSearch;
  },
): Promise<Page<MessageSummary>> {
  if (q !== undefined) {
    return callRoute(
      "searchAgentEmailMessages",
      {
        body: decodeRequestBody("searchAgentEmailMessages", "SearchAgentEmailMessagesRequest", {
          ...(cursor === undefined ? {} : { cursor }),
          ...(direction === undefined ? {} : { direction }),
          ...(status === undefined ? {} : { status }),
          limit: MAILBOX_PAGE_SIZE,
          query: q,
        }),
        path: { inboxId },
        scope,
      },
      accessToken,
    );
  }
  return fillPage(
    (pageCursor, limit) =>
      callRoute(
        "listAgentEmailMessages",
        { path: { inboxId }, query: { cursor: pageCursor, direction, limit, status }, scope },
        accessToken,
      ),
    cursor,
    MAILBOX_PAGE_SIZE,
  );
}

export function loadMessage(
  accessToken: string,
  scope: EnvironmentScope,
  messageId: string,
): Promise<AgentEmailMessage> {
  return callRoute("getAgentEmailMessage", { path: { messageId }, scope }, accessToken);
}

/** The runtime filters by status after paging, so short pages are filled. */
export function loadDraftPage(
  accessToken: string,
  scope: EnvironmentScope,
  {
    cursor,
    inboxId,
    status,
  }: {
    readonly cursor: string | undefined;
    readonly inboxId: string;
    readonly status: DraftStatus | undefined;
  },
): Promise<Page<AgentEmailDraft>> {
  return fillPage(
    (pageCursor, limit) =>
      callRoute(
        "listAgentEmailDrafts",
        { path: { inboxId }, query: { cursor: pageCursor, limit, status }, scope },
        accessToken,
      ),
    cursor,
    MAILBOX_PAGE_SIZE,
  );
}

export function loadDraft(
  accessToken: string,
  scope: EnvironmentScope,
  draftId: string,
): Promise<AgentEmailDraft> {
  return callRoute("getAgentEmailDraft", { path: { draftId }, scope }, accessToken);
}

export async function loadComposeContext(
  accessToken: string,
  scope: EnvironmentScope,
  inboxId: string,
): Promise<ComposeContext> {
  const [sender, inboxes, policy] = await Promise.all([
    callRoute("getAgentEmailInbox", { path: { inboxId }, scope }, accessToken),
    collectPagesUpTo(
      (cursor) =>
        callRoute(
          "listAgentEmailInboxes",
          { query: { cursor, limit: API_PAGE_LIMIT, status: "active" }, scope },
          accessToken,
        ),
      MAX_INBOX_PAGES,
    ),
    loadPolicyState(accessToken, scope),
  ]);
  return {
    allowlist: policy.kind === "saved" ? (policy.policy.allowlist ?? []) : [],
    complete: inboxes.complete,
    maxAttachmentBytes: policy.kind === "saved" ? policy.policy.maxAttachmentBytes : undefined,
    ownInboxes: inboxes.items
      .filter((inbox) => inbox.domainId === sender.domainId)
      .map((inbox) => inbox.address.toLowerCase()),
  };
}
