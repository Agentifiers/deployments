import "@tanstack/react-start/server-only";
import type { AgentReleaseEntry } from "../observability/agent-labels.ts";
import { PlatformRequestError } from "./platform-api.ts";

export const PAGE_SIZE = 50;
export const API_PAGE_LIMIT = 100;
const MAX_PAGE_REQUESTS = 10;

export interface Page<Item> {
  readonly items: readonly Item[];
  readonly nextCursor?: string | undefined;
}

export interface LabeledPage<Item> extends Page<Item> {
  readonly releases: readonly AgentReleaseEntry[];
}

export async function fillPage<Item>(
  fetchPage: (cursor: string | undefined, limit: number) => Promise<Page<Item>>,
  cursor: string | undefined,
  size: number,
  maxRequests = MAX_PAGE_REQUESTS,
): Promise<Page<Item>> {
  const items: Item[] = [];
  const seen = new Set<string>();
  let next = cursor;
  for (let request = 0; request < maxRequests; request += 1) {
    const pageCursor = next;
    const limit = Math.min(API_PAGE_LIMIT, size - items.length);
    const page = await fetchPage(pageCursor, limit);
    items.push(...page.items);
    next = page.nextCursor ?? undefined;
    if (next === undefined || items.length >= size) break;
    if (seen.has(next)) {
      throw new PlatformRequestError("The platform API repeated a pagination cursor.");
    }
    seen.add(next);
  }
  return next === undefined ? { items } : { items, nextCursor: next };
}
