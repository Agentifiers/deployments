import "@tanstack/react-start/server-only";
import type { ConsoleOperation } from "../access.ts";
import {
  decodeGrant,
  decodeMemory,
  decodePage,
  decodePolicy,
  decodeQuality,
  decodeReviewItem,
  decodeSpace,
  type MemoryDecoder,
} from "../memory/decode.ts";
import {
  MEMORY_PAGE_LIMIT,
  qualitySince,
  REVIEW_SCAN_LIMIT,
  type GrantStatus,
  type Memory,
  type MemoryPolicy,
  type MemoryQuality,
  type MemoryReviewItem,
  type MemorySpace,
  type MemorySpaceGrant,
  type MemoryStatus,
  type QualityWindow,
  type ReviewQueuePage,
} from "../memory/model.ts";
import { walkPages, type FetchPage } from "../overview/status-counts.ts";
import type { EnvironmentScope } from "../scope.ts";
import { fillPage, PAGE_SIZE, type Page } from "./list-pages.ts";
import { callRoute, collectPages, PlatformRequestError } from "./platform-api.ts";

export function memoryView<Item>(
  operation: ConsoleOperation,
  decode: MemoryDecoder<Item>,
  value: unknown,
): Item {
  const view = decode(value);
  if (view === undefined) {
    throw new PlatformRequestError(
      `The platform returned a ${operation} response outside the console's Memory view.`,
    );
  }
  return view;
}

const decodeSpacePage = decodePage(decodeSpace);
const decodeGrantPage = decodePage(decodeGrant);
const decodePolicyPage = decodePage(decodePolicy);
const decodeMemoryPage = decodePage(decodeMemory);
const decodeReviewPage = decodePage(decodeReviewItem);
const REVIEW_SCAN_PAGES = REVIEW_SCAN_LIMIT / MEMORY_PAGE_LIMIT;

export function listSpaces(
  accessToken: string,
  scope: EnvironmentScope,
  cursor: string | undefined,
): Promise<Page<MemorySpace>> {
  return fillPage(
    async (pageCursor, limit) =>
      memoryView(
        "listMemorySpaces",
        decodeSpacePage,
        await callRoute(
          "listMemorySpaces",
          { query: { cursor: pageCursor, limit }, scope },
          accessToken,
        ),
      ),
    cursor,
    PAGE_SIZE,
  );
}

export async function listActiveSpaces(
  accessToken: string,
  scope: EnvironmentScope,
): Promise<readonly MemorySpace[]> {
  const spaces = await collectPages(async (cursor) =>
    memoryView(
      "listMemorySpaces",
      decodeSpacePage,
      await callRoute(
        "listMemorySpaces",
        { query: { cursor, limit: PAGE_SIZE }, scope },
        accessToken,
      ),
    ),
  );
  return spaces.filter((space) => space.status === "active");
}

export async function getSpace(
  accessToken: string,
  scope: EnvironmentScope,
  memorySpaceId: string,
): Promise<MemorySpace> {
  return memoryView(
    "getMemorySpace",
    decodeSpace,
    await callRoute("getMemorySpace", { path: { memorySpaceId }, scope }, accessToken),
  );
}

export function listPolicies(
  accessToken: string,
  scope: EnvironmentScope,
): Promise<readonly MemoryPolicy[]> {
  return collectPages(async (cursor) =>
    memoryView(
      "listMemoryPolicies",
      decodePolicyPage,
      await callRoute(
        "listMemoryPolicies",
        { query: { cursor, limit: PAGE_SIZE }, scope },
        accessToken,
      ),
    ),
  );
}

export function listGrants(
  accessToken: string,
  scope: EnvironmentScope,
  filter: { readonly memorySpaceId: string; readonly status: GrantStatus | "all" },
  cursor: string | undefined,
): Promise<Page<MemorySpaceGrant>> {
  return fillPage(
    async (pageCursor, limit) =>
      memoryView(
        "listMemorySpaceGrants",
        decodeGrantPage,
        await callRoute(
          "listMemorySpaceGrants",
          { query: { ...filter, cursor: pageCursor, limit }, scope },
          accessToken,
        ),
      ),
    cursor,
    PAGE_SIZE,
  );
}

export function listSpaceMemories(
  accessToken: string,
  scope: EnvironmentScope,
  filter: { readonly memorySpaceId: string; readonly status: MemoryStatus },
  cursor: string | undefined,
): Promise<Page<Memory>> {
  return fillPage(
    async (pageCursor, limit) =>
      memoryView(
        "listMemories",
        decodeMemoryPage,
        await callRoute(
          "listMemories",
          {
            query: {
              cursor: pageCursor,
              limit: Math.min(limit, MEMORY_PAGE_LIMIT),
              space: filter.memorySpaceId,
              status: filter.status,
            },
            scope,
          },
          accessToken,
        ),
      ),
    cursor,
    PAGE_SIZE,
  );
}

const REVIEW_SCAN_STATUSES = ["active", "archived"] as const satisfies readonly MemoryStatus[];

/**
 * The list orders memories by status before time, so a scan of every status would read all the
 * deleted tombstones first. Open items point at live memories, so active ones come first, then
 * archived ones, within one page budget.
 */
export async function joinReviewMemories(
  items: readonly MemoryReviewItem[],
  fetchMemories: (status: MemoryStatus) => FetchPage<Memory>,
): Promise<Omit<ReviewQueuePage, "nextCursor">> {
  const wanted = new Set(items.map((item) => item.memoryId));
  const found = new Map<string, Memory>();
  const foundAll = () => found.size === wanted.size;
  let pagesLeft = REVIEW_SCAN_PAGES;
  let listsEnded = true;
  for (const status of REVIEW_SCAN_STATUSES) {
    if (foundAll()) break;
    let pagesRead = 0;
    const ended =
      pagesLeft > 0 &&
      (await walkPages(fetchMemories(status), pagesLeft, (memories) => {
        pagesRead += 1;
        for (const memory of memories) {
          if (wanted.has(memory.id)) found.set(memory.id, memory);
        }
        return foundAll();
      }));
    pagesLeft -= pagesRead;
    listsEnded &&= ended;
  }
  return {
    items: items.map((item) => ({ item, memory: found.get(item.memoryId) })),
    scannedAllMemories: foundAll() || listsEnded,
  };
}

export async function listReviewQueue(
  accessToken: string,
  scope: EnvironmentScope,
  cursor: string | undefined,
): Promise<ReviewQueuePage> {
  const page = await fillPage(
    async (pageCursor, limit) =>
      memoryView(
        "listMemoryReviewItems",
        decodeReviewPage,
        await callRoute(
          "listMemoryReviewItems",
          { query: { cursor: pageCursor, limit, status: "open" }, scope },
          accessToken,
        ),
      ),
    cursor,
    PAGE_SIZE,
  );
  const joined = await joinReviewMemories(
    page.items,
    (status) => async (memoryCursor) =>
      memoryView(
        "listMemories",
        decodeMemoryPage,
        await callRoute(
          "listMemories",
          { query: { cursor: memoryCursor, limit: MEMORY_PAGE_LIMIT, status }, scope },
          accessToken,
        ),
      ),
  );
  return { ...joined, nextCursor: page.nextCursor };
}

export async function getQuality(
  accessToken: string,
  scope: EnvironmentScope,
  days: QualityWindow,
): Promise<MemoryQuality> {
  const since = qualitySince(days, new Date());
  return memoryView(
    "getMemoryQuality",
    decodeQuality,
    await callRoute("getMemoryQuality", { query: { since }, scope }, accessToken),
  );
}
