import { formatExact } from "../observability/format.ts";

/** `currentState` values of an agent deployment, in strip order. */
export const DEPLOYMENT_STATES = ["ready", "deploying", "failed", "paused", "stopped"] as const;
export type DeploymentState = (typeof DEPLOYMENT_STATES)[number];

/**
 * Provider connection statuses that need an operator (`packages/db` provider-connection records:
 * active, disconnected, error, reauthorization-required).
 */
export const CONNECTION_PROBLEM_STATUSES = ["error", "reauthorization-required"] as const;
export type ConnectionProblemStatus = (typeof CONNECTION_PROBLEM_STATUSES)[number];

export type FetchPage<Item> = (cursor: string | undefined) => Promise<{
  readonly items: readonly Item[];
  readonly nextCursor?: string | null | undefined;
}>;

/** Counts per key; `complete` is false when paging stopped before the list ended. */
export interface Tally<Key extends string> {
  readonly complete: boolean;
  readonly counts: Readonly<Record<Key, number>>;
}

/** A count that stops at `cap`; `complete` is false when more matching items may exist. */
export interface CappedCount {
  readonly complete: boolean;
  readonly count: number;
}

/**
 * Follows `nextCursor` for at most `maxPages` pages, calling `visit` per page; `visit` returns
 * true to stop early. Resolves to whether the list ended. Filtered lists may return short (even
 * empty) pages with a cursor, so the page budget, not page size, bounds the work.
 */
export async function walkPages<Item>(
  fetchPage: FetchPage<Item>,
  maxPages: number,
  visit: (items: readonly Item[]) => boolean,
): Promise<boolean> {
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const result = await fetchPage(cursor);
    const stop = visit(result.items);
    cursor = result.nextCursor ?? undefined;
    if (cursor === undefined) return true;
    if (seen.has(cursor)) throw new Error("The platform API repeated a pagination cursor.");
    seen.add(cursor);
    if (stop) return false;
  }
  return false;
}

/** Tallies items by key across at most `maxPages` pages; keys outside `keys` are skipped. */
export async function tallyPages<Item, Key extends string>(
  keys: readonly Key[],
  fetchPage: FetchPage<Item>,
  keyOf: (item: Item) => string,
  maxPages: number,
): Promise<Tally<Key>> {
  const counts = Object.fromEntries(keys.map((key) => [key, 0])) as Record<Key, number>;
  const complete = await walkPages(fetchPage, maxPages, (items) => {
    for (const item of items) {
      const key = keyOf(item);
      if (Object.hasOwn(counts, key)) counts[key as Key] += 1;
    }
    return false;
  });
  return { complete, counts };
}

/** The items of at most `maxPages` pages; `complete` is false when the list goes on. */
export async function collectPagesUpTo<Item>(
  fetchPage: FetchPage<Item>,
  maxPages: number,
): Promise<{ readonly complete: boolean; readonly items: readonly Item[] }> {
  const items: Item[] = [];
  const complete = await walkPages(fetchPage, maxPages, (page) => {
    items.push(...page);
    return false;
  });
  return { complete, items };
}

/**
 * Counts a server-filtered list up to `cap` items: stops once `cap` is reached with more pages
 * left, or after `maxPages` pages, and reports the count as a lower bound.
 */
export async function countPages<Item>(
  fetchPage: FetchPage<Item>,
  cap: number,
  maxPages: number,
): Promise<CappedCount> {
  let count = 0;
  const complete = await walkPages(fetchPage, maxPages, (items) => {
    count += items.length;
    return count >= cap;
  });
  return { complete, count: complete ? count : Math.min(count, cap) };
}

/** `42`, or `100+` when the count is a lower bound. */
export function formatCount(count: number, complete: boolean) {
  return complete ? formatExact(count) : `${formatExact(count)}+`;
}
