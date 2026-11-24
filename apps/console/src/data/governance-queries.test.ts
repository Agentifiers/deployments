import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { ErasureState } from "../governance/erasure-state.ts";
import { erasureQuery, untilResumed } from "./governance-queries.ts";
import { DEFAULT_STALE_MS } from "./refresh.ts";

const ORGANIZATION = "01ARZ3NDEKTSV4RRFFQ69G600C";
const OPERATION = "01M4D00000000000000000000E";
const blocked: ErasureState = {
  blocker: { kind: "tenant_has_active_runs" },
  kind: "blocked",
  operationId: OPERATION,
};
const running: ErasureState = { kind: "in_progress", operationId: OPERATION };

function blockedInCache(answers: readonly ErasureState[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { staleTime: DEFAULT_STALE_MS } },
  });
  const server = { reads: 0 };
  const query = {
    ...erasureQuery(ORGANIZATION, OPERATION),
    queryFn: async () => answers[Math.min(server.reads++, answers.length - 1)] ?? blocked,
  };
  queryClient.setQueryData(query.queryKey, blocked);
  return { query, queryClient, server };
}

const noPause = async () => {};

describe("untilResumed", () => {
  test("reads past the cached blocked erasure until the resumed run picks it up", async () => {
    const { query, queryClient, server } = blockedInCache([blocked, blocked, running]);
    await untilResumed(queryClient, query, new AbortController().signal, noPause);
    expect(server.reads).toBe(3);
    expect(queryClient.getQueryData<ErasureState>(query.queryKey)).toEqual(running);
  });

  test("stops after twelve reads and leaves the erasure blocked", async () => {
    const { query, queryClient, server } = blockedInCache([blocked]);
    await untilResumed(queryClient, query, new AbortController().signal, noPause);
    expect(server.reads).toBe(12);
    expect(queryClient.getQueryData<ErasureState>(query.queryKey)).toEqual(blocked);
  });

  test("stops reading once the page that started it goes away", async () => {
    const { query, queryClient, server } = blockedInCache([blocked]);
    const page = new AbortController();
    let pauses = 0;
    await untilResumed(queryClient, query, page.signal, async () => {
      pauses += 1;
      if (pauses === 3) page.abort();
    });
    expect(server.reads).toBe(2);
  });

  test("leaving the page ends the wait between reads at once", async () => {
    const { query, queryClient, server } = blockedInCache([blocked]);
    const page = new AbortController();
    const started = performance.now();
    const loop = untilResumed(queryClient, query, page.signal);
    page.abort();
    await loop;
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(server.reads).toBe(0);
  });
});
