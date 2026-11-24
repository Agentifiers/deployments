import { QueryProblem } from "./api-query.ts";

export interface QueryLimits {
  /** Queries running at once across organizations; sized to the ClickHouse node's cores. */
  readonly global: number;
  /** Queries one organization runs at once, so one tenant cannot hold every slot. */
  readonly organization: number;
  /** Longest a query waits for a slot before it is refused with a 429. */
  readonly maxWaitMs: number;
  /** Most queries waiting at once; a query beyond it is refused at once. */
  readonly maxWaiting: number;
}

interface Waiter {
  readonly organizationId: string;
  readonly admit: () => void;
}

/**
 * Admits tenant queries up to the global and per-organization limits. A query over a limit waits
 * in arrival order for a slot instead of failing, so a dashboard's burst of calls is served a few
 * hundred milliseconds later rather than retried seconds later. A waiter whose organization is at
 * its own limit does not hold up other organizations' waiters. A wait longer than `maxWaitMs`, or
 * a full queue, is refused with the 429 the console retries.
 */
export function createQueryGate(limits: QueryLimits) {
  let running = 0;
  const runningByOrganization = new Map<string, number>();
  const waiting: Waiter[] = [];

  const admissible = (organizationId: string) =>
    running < limits.global &&
    (runningByOrganization.get(organizationId) ?? 0) < limits.organization;

  function start(organizationId: string) {
    running += 1;
    runningByOrganization.set(organizationId, (runningByOrganization.get(organizationId) ?? 0) + 1);
  }

  function finish(organizationId: string) {
    running -= 1;
    const remaining = (runningByOrganization.get(organizationId) ?? 1) - 1;
    if (remaining === 0) runningByOrganization.delete(organizationId);
    else runningByOrganization.set(organizationId, remaining);
    for (let index = 0; index < waiting.length && running < limits.global; ) {
      const waiter = waiting[index]!;
      if (admissible(waiter.organizationId)) {
        waiting.splice(index, 1);
        start(waiter.organizationId);
        waiter.admit();
      } else index += 1;
    }
  }

  function refusal(organizationId: string) {
    return (runningByOrganization.get(organizationId) ?? 0) >= limits.organization
      ? new QueryProblem(
          429,
          "observability_query_concurrency_exceeded",
          "Too many observability queries are active for this organization.",
        )
      : new QueryProblem(
          429,
          "observability_query_capacity_exceeded",
          "The observability query service is at capacity.",
        );
  }

  async function admit(organizationId: string) {
    // finish() admits every admissible waiter, so a free slot here is not owed to one.
    if (admissible(organizationId)) {
      start(organizationId);
      return;
    }
    if (waiting.length >= limits.maxWaiting) throw refusal(organizationId);
    const { promise, reject, resolve } = Promise.withResolvers<void>();
    const timer = setTimeout(() => {
      waiting.splice(waiting.indexOf(waiter), 1);
      reject(refusal(organizationId));
    }, limits.maxWaitMs);
    const waiter: Waiter = {
      admit: () => {
        clearTimeout(timer);
        resolve();
      },
      organizationId,
    };
    waiting.push(waiter);
    await promise;
  }

  return {
    async run<Result>(organizationId: string, task: () => Promise<Result>): Promise<Result> {
      await admit(organizationId);
      try {
        return await task();
      } finally {
        finish(organizationId);
      }
    },
  };
}

export interface CachedResponse {
  readonly body: string;
  readonly contentType: string;
}

/**
 * Successful responses kept for `ttlMs` under a caller-built key. A request that arrives while
 * an identical one is running shares its result. An entry resolving to `undefined` (a failure)
 * is dropped, and its waiters run their own request.
 */
export function createResponseCache(options: {
  readonly maxEntries: number;
  readonly now: () => number;
  readonly ttlMs: number;
}) {
  const entries = new Map<
    string,
    { readonly expiresAt: number; readonly response: Promise<CachedResponse | undefined> }
  >();
  return {
    read(key: string) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt > options.now()) return entry.response;
      entries.delete(key);
      return undefined;
    },
    write(key: string, response: Promise<CachedResponse | undefined>) {
      if (entries.size >= options.maxEntries) {
        const now = options.now();
        for (const [entryKey, entry] of entries) {
          if (entry.expiresAt <= now) entries.delete(entryKey);
        }
        if (entries.size >= options.maxEntries) entries.delete(entries.keys().next().value!);
      }
      const entry = { expiresAt: options.now() + options.ttlMs, response };
      entries.set(key, entry);
      void response.then((value) => {
        if (value === undefined && entries.get(key) === entry) entries.delete(key);
      });
    },
    /** Drops every entry, live or in flight, whose key starts with `prefix`. */
    evict(prefix: string) {
      for (const key of entries.keys()) if (key.startsWith(prefix)) entries.delete(key);
    },
  };
}
