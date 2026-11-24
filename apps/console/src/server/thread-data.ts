import "@tanstack/react-start/server-only";
import { matchesThreadFilters, type ThreadFilters } from "../runs/thread-filters.ts";
import type { EnvironmentScope } from "../scope.ts";
import { fillPage, PAGE_SIZE, type Page } from "./list-pages.ts";
import { callRoute, type RouteResponse } from "./platform-api.ts";
import type { Thread } from "./runtime-data.ts";

export type ConversationErasure = RouteResponse<"getThreadErasure">["erasure"];

/**
 * One page of the environment's customer threads, most recently active first. The API filters
 * none of the list's fields, so each API page is narrowed here and a page may come back short
 * while more threads remain.
 */
export function loadThreadPage(
  accessToken: string,
  scope: EnvironmentScope,
  filters: ThreadFilters,
  cursor: string | undefined,
): Promise<Page<Thread>> {
  return fillPage(
    (pageCursor, limit) =>
      callRoute("listThreads", { query: { cursor: pageCursor, limit }, scope }, accessToken).then(
        ({ nextCursor, threads }) => ({
          items: threads.filter((thread) => matchesThreadFilters(thread, filters)),
          nextCursor,
        }),
      ),
    cursor,
    PAGE_SIZE,
  );
}

export function archiveThread(
  accessToken: string,
  scope: EnvironmentScope,
  threadId: string,
): Promise<Thread> {
  return callRoute("archiveThread", { path: { threadId }, scope }, accessToken);
}

export async function eraseThread(
  accessToken: string,
  scope: EnvironmentScope,
  threadId: string,
): Promise<ConversationErasure> {
  const { erasure } = await callRoute("eraseThread", { path: { threadId }, scope }, accessToken);
  return erasure;
}

export async function loadThreadErasure(
  accessToken: string,
  scope: EnvironmentScope,
  threadId: string,
  erasureId: string,
): Promise<ConversationErasure> {
  const { erasure } = await callRoute(
    "getThreadErasure",
    { path: { erasureId, threadId }, scope },
    accessToken,
  );
  return erasure;
}

/** The end-user ID is the tenant's own identifier; the platform keeps only a keyed pseudonym. */
export async function eraseEndUser(
  accessToken: string,
  scope: EnvironmentScope,
  endUserId: string,
): Promise<ConversationErasure> {
  const { erasure } = await callRoute("eraseEndUser", { body: { endUserId }, scope }, accessToken);
  return erasure;
}

export async function loadEndUserErasure(
  accessToken: string,
  scope: EnvironmentScope,
  erasureId: string,
): Promise<ConversationErasure> {
  const { erasure } = await callRoute(
    "getEndUserErasure",
    { path: { erasureId }, scope },
    accessToken,
  );
  return erasure;
}
