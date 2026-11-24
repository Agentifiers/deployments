import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import {
  messageInFlight,
  parseDraftSearch,
  parseMessageSearch,
  parseThreadSearch,
  type DraftSearch,
  type MessageSearch,
  type ThreadSearch,
} from "../email/mailbox-state.ts";
import type { EnvironmentScope } from "../scope.ts";
import {
  loadComposeContext,
  loadDraft,
  loadDraftPage,
  loadMessage,
  loadMessagePage,
  loadThread,
  loadThreadPage,
} from "../server/agent-email-mailbox-data.ts";
import { requireAccessToken } from "../server/session.ts";
import { agentEmailKey } from "./agent-email-setup-queries.ts";
import {
  fields,
  pageInput,
  scopedInput,
  type PageInput,
  type ScopedInput,
} from "./server-input.ts";

const IN_FLIGHT_POLL_MS = 5_000;

const fetchThreadPage = createServerFn({ method: "GET" })
  .validator((input: PageInput & ThreadSearch & { readonly inboxId: string }) => ({
    ...pageInput(input, ["inboxId"]),
    ...parseThreadSearch(fields(input)),
  }))
  .handler(async ({ data }) =>
    loadThreadPage(await requireAccessToken(), data.scope, {
      cursor: data.cursor,
      inboxId: data.inboxId,
      q: data.q,
    }),
  );

const fetchThread = createServerFn({ method: "GET" })
  .validator((input: PageInput & { readonly inboxId: string; readonly threadId: string }) =>
    pageInput(input, ["inboxId", "threadId"]),
  )
  .handler(async ({ data }) =>
    loadThread(await requireAccessToken(), data.scope, {
      cursor: data.cursor,
      inboxId: data.inboxId,
      threadId: data.threadId,
    }),
  );

const fetchMessagePage = createServerFn({ method: "GET" })
  .validator((input: PageInput & MessageSearch & { readonly inboxId: string }) => ({
    ...pageInput(input, ["inboxId"]),
    search: parseMessageSearch(fields(input)),
  }))
  .handler(async ({ data }) =>
    loadMessagePage(await requireAccessToken(), data.scope, {
      cursor: data.cursor,
      inboxId: data.inboxId,
      search: data.search,
    }),
  );

const fetchMessage = createServerFn({ method: "GET" })
  .validator((input: ScopedInput & { readonly messageId: string }) =>
    scopedInput(input, ["messageId"]),
  )
  .handler(async ({ data }) => loadMessage(await requireAccessToken(), data.scope, data.messageId));

const fetchDraftPage = createServerFn({ method: "GET" })
  .validator((input: PageInput & DraftSearch & { readonly inboxId: string }) => ({
    ...pageInput(input, ["inboxId"]),
    ...parseDraftSearch(fields(input)),
  }))
  .handler(async ({ data }) =>
    loadDraftPage(await requireAccessToken(), data.scope, {
      cursor: data.cursor,
      inboxId: data.inboxId,
      status: data.status,
    }),
  );

const fetchDraft = createServerFn({ method: "GET" })
  .validator((input: ScopedInput & { readonly draftId: string }) => scopedInput(input, ["draftId"]))
  .handler(async ({ data }) => loadDraft(await requireAccessToken(), data.scope, data.draftId));

const fetchComposeContext = createServerFn({ method: "GET" })
  .validator((input: ScopedInput & { readonly inboxId: string }) => scopedInput(input, ["inboxId"]))
  .handler(async ({ data }) =>
    loadComposeContext(await requireAccessToken(), data.scope, data.inboxId),
  );

const mailboxKey = (scope: EnvironmentScope) => [...agentEmailKey(scope), "mailbox"] as const;

const cursorOf = (pageParam: string | undefined) =>
  pageParam === undefined ? {} : { cursor: pageParam };

export const threadPagesQuery = (scope: EnvironmentScope, inboxId: string, search: ThreadSearch) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchThreadPage({ data: { inboxId, scope, ...search, ...cursorOf(pageParam) } }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: [...mailboxKey(scope), "threads", inboxId, search],
  });

export const threadQuery = (scope: EnvironmentScope, inboxId: string, threadId: string) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchThread({ data: { inboxId, scope, threadId, ...cursorOf(pageParam) } }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: [...mailboxKey(scope), "thread", threadId],
  });

export const messagePagesQuery = (
  scope: EnvironmentScope,
  inboxId: string,
  search: MessageSearch,
) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchMessagePage({ data: { inboxId, scope, ...search, ...cursorOf(pageParam) } }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: [...mailboxKey(scope), "messages", inboxId, search],
  });

/** Bodies stay out of SSR's dehydrated state: message and draft pages render client-only. */
export const messageQuery = (scope: EnvironmentScope, messageId: string) =>
  queryOptions({
    meta: { dehydrate: false },
    queryFn: () => fetchMessage({ data: { messageId, scope } }),
    queryKey: [...mailboxKey(scope), "message", messageId],
    refetchInterval: (query) =>
      query.state.data && messageInFlight(query.state.data) ? IN_FLIGHT_POLL_MS : false,
  });

export const draftPagesQuery = (scope: EnvironmentScope, inboxId: string, search: DraftSearch) =>
  infiniteQueryOptions({
    queryFn: ({ pageParam }) =>
      fetchDraftPage({ data: { inboxId, scope, ...search, ...cursorOf(pageParam) } }),
    getNextPageParam: (page) => page.nextCursor,
    initialPageParam: undefined as string | undefined,
    queryKey: [...mailboxKey(scope), "drafts", inboxId, search],
  });

export const draftQuery = (scope: EnvironmentScope, draftId: string) =>
  queryOptions({
    meta: { dehydrate: false },
    queryFn: () => fetchDraft({ data: { draftId, scope } }),
    queryKey: [...mailboxKey(scope), "draft", draftId],
  });

export const composeContextQuery = (scope: EnvironmentScope, inboxId: string) =>
  queryOptions({
    queryFn: () => fetchComposeContext({ data: { inboxId, scope } }),
    queryKey: [...mailboxKey(scope), "compose-context", inboxId],
  });
