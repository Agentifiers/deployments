import { describe, expect, test } from "bun:test";
import { attemptAfterFailure, freshAttempt } from "../components/keyed-attempt.ts";
import { snapshotFor, type KeyedSnapshot } from "../components/keyed-snapshot.ts";
import { PlatformApiError } from "../errors.ts";
import { decodeMemory } from "../memory/decode.ts";
import {
  reviewRequest,
  type Memory,
  type MemoryReviewItem,
  type MemoryStatus,
  type ReviewDecision,
  type ReviewRequest,
} from "../memory/model.ts";
import {
  APPROVED_MEMORY,
  MEMORY_ID,
  OPEN_REVIEW_ITEM,
  PENDING_MEMORY,
  RATED_RETRIEVAL,
  RETRIEVAL_ID,
  REVIEW_ID,
  SEARCH_RESPONSE,
  SPACE_ID,
  TENANT,
} from "../memory/records.fixture.ts";
import {
  changeLifecycle,
  exportSpace,
  importMemories,
  recordFeedback,
  resolveReview,
  searchMemories,
  type CallRoute,
} from "./memory-actions.ts";
import { joinReviewMemories } from "./memory-data.ts";

interface Sent {
  readonly input: unknown;
  readonly name: string;
}

function routedApi(respond: (name: string, input: unknown, call: number) => unknown) {
  const sent: Sent[] = [];
  const callRoute = (async (name: string, input: unknown) => {
    sent.push({ input, name });
    const response = respond(name, input, sent.length);
    if (response instanceof Error) throw response;
    return response;
  }) as unknown as CallRoute;
  return { callRoute, sent };
}

const mutation = { accessToken: "token", idempotencyKey: "key-1", scope: TENANT };

const notEnabled = (operation: string) =>
  new PlatformApiError(operation, {
    code: "memory_internal_error",
    status: 500,
    title: "Memory request failed",
  });

describe("importMemories", () => {
  test("sends the import under the dialog's key and counts each outcome", async () => {
    const api = routedApi(() => ({
      imported: [PENDING_MEMORY],
      rejected: [{ index: 1, reason: "Memory content contains a secret." }],
      replayed: [],
    }));
    const body = {
      data: [
        { content: "Ships on Thursdays.", scope: "organization" },
        { content: "token=abc", scope: "organization" },
      ],
      memorySpaceId: SPACE_ID,
    };
    expect(await importMemories({ ...mutation, body }, api.callRoute)).toEqual({
      imported: 1,
      rejected: [{ index: 1, reason: "Memory content contains a secret." }],
      replayed: 0,
    });
    expect(api.sent).toEqual([
      { input: { body, idempotencyKey: "key-1", scope: TENANT }, name: "importMemories" },
    ]);
  });

  test("passes the missing placement through as the platform's problem", async () => {
    const failure = notEnabled("importMemories");
    const api = routedApi(() => failure);
    const body = { data: [{ content: "One.", scope: "organization" }], memorySpaceId: SPACE_ID };
    expect(
      await importMemories({ ...mutation, body }, api.callRoute).catch((error: unknown) => error),
    ).toBe(failure);
  });
});

describe("exportSpace", () => {
  test("follows the cursor and keeps each record's data", async () => {
    const api = routedApi((_name, _input, call) =>
      call === 1
        ? { format: "json", items: [PENDING_MEMORY], nextCursor: "c2" }
        : { format: "json", items: [APPROVED_MEMORY] },
    );
    expect(
      await exportSpace(
        { accessToken: "token", memorySpaceId: SPACE_ID, scope: TENANT },
        api.callRoute,
      ),
    ).toEqual({ complete: true, memories: [PENDING_MEMORY.data, APPROVED_MEMORY.data] });
    expect(api.sent.map(({ input }) => input)).toEqual([
      { body: { limit: 20, memorySpaceId: SPACE_ID }, scope: TENANT },
      { body: { cursor: "c2", limit: 20, memorySpaceId: SPACE_ID }, scope: TENANT },
    ]);
  });

  test("stops after 500 memories and says the file is partial", async () => {
    const api = routedApi((_name, _input, call) => ({
      items: [PENDING_MEMORY],
      nextCursor: `c${call + 1}`,
    }));
    const result = await exportSpace(
      { accessToken: "token", memorySpaceId: SPACE_ID, scope: TENANT },
      api.callRoute,
    );
    expect(result.complete).toBe(false);
    expect(api.sent).toHaveLength(25);
  });
});

describe("changeLifecycle", () => {
  test("each action calls its own route and returns the memory's new state", async () => {
    const api = routedApi(() => APPROVED_MEMORY);
    for (const action of ["archive", "restore"] as const) {
      await changeLifecycle({ ...mutation, action, memoryId: MEMORY_ID }, api.callRoute);
    }
    const deleted = await changeLifecycle(
      { ...mutation, action: "delete", memoryId: MEMORY_ID, reason: "duplicate" },
      api.callRoute,
    );
    expect(deleted).toMatchObject({ id: MEMORY_ID, reviewStatus: "approved", version: 1 });
    const path = { memoryId: MEMORY_ID };
    expect(api.sent).toEqual([
      { input: { idempotencyKey: "key-1", path, scope: TENANT }, name: "archiveMemory" },
      { input: { idempotencyKey: "key-1", path, scope: TENANT }, name: "restoreMemory" },
      {
        input: { body: { reason: "duplicate" }, idempotencyKey: "key-1", path, scope: TENANT },
        name: "deleteMemory",
      },
    ]);
  });
});

describe("resolveReview", () => {
  test("posts the decision to the memory's review item", async () => {
    const api = routedApi(() => ({ memory: APPROVED_MEMORY, review: OPEN_REVIEW_ITEM }));
    const resolved = await resolveReview(
      {
        ...mutation,
        body: { content: "Ships on Fridays.", decision: "edit" },
        memoryId: MEMORY_ID,
        reviewId: REVIEW_ID,
      },
      api.callRoute,
    );
    expect(resolved.memory.reviewStatus).toBe("approved");
    expect(resolved.review.id).toBe(REVIEW_ID);
    expect(api.sent).toEqual([
      {
        input: {
          body: { content: "Ships on Fridays.", decision: "edit" },
          idempotencyKey: "key-1",
          path: { memoryId: MEMORY_ID, reviewId: REVIEW_ID },
          scope: TENANT,
        },
        name: "resolveMemoryReview",
      },
    ]);
  });

  test("refuses a decision outside the contract before calling the platform", async () => {
    const api = routedApi(() => ({}));
    const refused = await resolveReview(
      { ...mutation, body: { decision: "merge" }, memoryId: MEMORY_ID, reviewId: REVIEW_ID },
      api.callRoute,
    ).catch((error: unknown) => error);
    expect(refused).toMatchObject({ problem: { status: 400 } });
    expect(api.sent).toEqual([]);
  });
});

function idempotentPlatform(respond: (name: string) => unknown) {
  const applied: unknown[] = [];
  const keys = new Map<string, string>();
  let lose = 0;
  const { callRoute, sent } = routedApi((name, input) => {
    const { body, idempotencyKey } = input as { body?: unknown; idempotencyKey: string };
    const fingerprint = JSON.stringify(body ?? {});
    const earlier = keys.get(idempotencyKey);
    if (earlier !== undefined && earlier !== fingerprint) {
      return new PlatformApiError(name, { code: "idempotency_conflict", status: 409, title: "T" });
    }
    if (earlier === undefined) {
      keys.set(idempotencyKey, fingerprint);
      applied.push(body ?? {});
    }
    if (lose > 0) {
      lose -= 1;
      return new PlatformApiError(name, { code: "bad_gateway", status: 502, title: "T" });
    }
    return respond(name);
  });
  return { applied, callRoute, loseNext: () => (lose += 1), sent };
}

function keyedDialog<Body>(send: (body: Body, idempotencyKey: string) => Promise<unknown>) {
  let attempt = freshAttempt();
  let held: KeyedSnapshot<Body> | undefined;
  return async (live: Body) => {
    held = snapshotFor(held, attempt.key, attempt.state === "resend", live);
    try {
      await send(held.value, attempt.key);
      return "applied";
    } catch (error) {
      attempt = attemptAfterFailure(attempt, error);
      return error instanceof PlatformApiError ? error.problem.code : "failed";
    }
  };
}

describe("a keyed memory dialog resubmitted after a lost response", () => {
  test("Resolve resends the decision it sent, not the one picked since", async () => {
    const platform = idempotentPlatform(() => ({
      memory: APPROVED_MEMORY,
      review: OPEN_REVIEW_ITEM,
    }));
    const submit = keyedDialog<ReviewRequest>((body, idempotencyKey) =>
      resolveReview(
        { ...mutation, body, idempotencyKey, memoryId: MEMORY_ID, reviewId: REVIEW_ID },
        platform.callRoute,
      ),
    );
    const draft = (decision: ReviewDecision, content = "") => {
      const parsed = reviewRequest({ content, decision, reason: "" });
      if (!parsed.ok) throw new Error(parsed.problem);
      return parsed.request;
    };
    platform.loseNext();
    expect([
      await submit(draft("edit", "Ships on Fridays.")),
      await submit(draft("reject")),
    ]).toEqual(["bad_gateway", "applied"]);
    expect(platform.applied).toEqual([{ content: "Ships on Fridays.", decision: "edit" }]);
  });

  test("Delete resends the reason it sent, not the one typed since", async () => {
    const platform = idempotentPlatform(() => APPROVED_MEMORY);
    const submit = keyedDialog<string | undefined>((reason, idempotencyKey) =>
      changeLifecycle(
        {
          ...mutation,
          action: "delete",
          idempotencyKey,
          memoryId: MEMORY_ID,
          ...(reason === undefined ? {} : { reason }),
        },
        platform.callRoute,
      ),
    );
    platform.loseNext();
    expect([await submit("duplicate"), await submit("stale")]).toEqual(["bad_gateway", "applied"]);
    expect(platform.applied).toEqual([{ reason: "duplicate" }]);
  });
});

describe("searchMemories", () => {
  const body = { memorySpaceIds: [SPACE_ID], query: "release day", topK: 10 };

  test("a policy search and a strategy search call different routes", async () => {
    const api = routedApi(() => SEARCH_RESPONSE);
    const policy = await searchMemories(
      { accessToken: "token", request: { body, kind: "policy" }, scope: TENANT },
      api.callRoute,
    );
    await searchMemories(
      {
        accessToken: "token",
        request: { body: { ...body, strategy: "hybrid-rerank-v1" }, kind: "strategy" },
        scope: TENANT,
      },
      api.callRoute,
    );
    expect(policy.hits.map((hit) => [hit.memory.id, hit.retrievalId])).toEqual([
      [MEMORY_ID, RETRIEVAL_ID],
    ]);
    expect(api.sent).toEqual([
      { input: { body, scope: TENANT }, name: "searchMemories" },
      {
        input: { body: { ...body, strategy: "hybrid-rerank-v1" }, scope: TENANT },
        name: "strategySearchMemories",
      },
    ]);
  });

  test("passes the missing placement through as the platform's problem", async () => {
    const failure = notEnabled("searchMemories");
    const api = routedApi(() => failure);
    expect(
      await searchMemories(
        { accessToken: "token", request: { body, kind: "policy" }, scope: TENANT },
        api.callRoute,
      ).catch((error: unknown) => error),
    ).toBe(failure);
  });
});

describe("recordFeedback", () => {
  test("rates the retrieval the search returned", async () => {
    const api = routedApi(() => RATED_RETRIEVAL);
    expect(
      await recordFeedback(
        { ...mutation, memoryId: MEMORY_ID, retrievalId: RETRIEVAL_ID, usefulness: "useful" },
        api.callRoute,
      ),
    ).toEqual({ retrievalId: RETRIEVAL_ID, usefulness: "useful" });
    expect(api.sent).toEqual([
      {
        input: {
          body: { usefulness: "useful" },
          idempotencyKey: "key-1",
          path: { memoryId: MEMORY_ID, retrievalId: RETRIEVAL_ID },
          scope: TENANT,
        },
        name: "recordMemoryRetrievalFeedback",
      },
    ]);
  });
});

describe("joinReviewMemories", () => {
  const memory = decodeMemory(PENDING_MEMORY) as Memory;
  const other = { ...memory, id: "01M4FM00000000000000000009" };
  const item: MemoryReviewItem = {
    createdAt: "2026-10-09T06:00:00.000Z",
    id: REVIEW_ID,
    kind: "content-governance",
    memoryId: MEMORY_ID,
    status: "open",
    updatedAt: "2026-10-09T06:00:00.000Z",
    version: 0,
  };

  function memoryLists(pages: Readonly<Record<string, readonly (readonly Memory[])[]>>) {
    const reads: string[] = [];
    const fetch = (status: MemoryStatus) => async (cursor: string | undefined) => {
      const index = cursor === undefined ? 0 : Number(cursor);
      reads.push(`${status}#${index}`);
      const list = pages[status] ?? [];
      return {
        items: list[index] ?? [],
        ...(index + 1 < list.length ? { nextCursor: String(index + 1) } : {}),
      };
    };
    return { fetch, reads };
  }

  test("stops scanning once every reviewed memory is found and calls the scan whole", async () => {
    const lists = memoryLists({ active: [[other], [memory], [other]] });
    expect(await joinReviewMemories([item], lists.fetch)).toEqual({
      items: [{ item, memory }],
      scannedAllMemories: true,
    });
    expect(lists.reads).toEqual(["active#0", "active#1"]);
  });

  test("reads active memories before archived ones, and never deleted ones", async () => {
    const archived: Memory =
      memory.status === "deleted" ? memory : { ...memory, status: "archived" };
    const lists = memoryLists({
      active: [[other], [other]],
      archived: [[archived]],
      deleted: [[memory]],
    });
    expect(await joinReviewMemories([item], lists.fetch)).toEqual({
      items: [{ item, memory: archived }],
      scannedAllMemories: true,
    });
    expect(lists.reads).toEqual(["active#0", "active#1", "archived#0"]);
  });

  test("says whether a missing memory was outside the scan or absent from both lists", async () => {
    const whole = memoryLists({ active: [[other]], archived: [[other]] });
    expect(await joinReviewMemories([item], whole.fetch)).toEqual({
      items: [{ item, memory: undefined }],
      scannedAllMemories: true,
    });
    const endless = Array.from({ length: 30 }, () => [other]);
    const activeOnly = memoryLists({ active: endless, archived: [[memory]] });
    expect(await joinReviewMemories([item], activeOnly.fetch)).toEqual({
      items: [{ item, memory: undefined }],
      scannedAllMemories: false,
    });
    expect(activeOnly.reads).toHaveLength(10);
    expect(activeOnly.reads.every((read) => read.startsWith("active#"))).toBe(true);
  });

  test("the archived list gets the page budget the active list left", async () => {
    const endless = Array.from({ length: 30 }, () => [other]);
    const lists = memoryLists({ active: [[other], [other], [other]], archived: endless });
    expect(await joinReviewMemories([item], lists.fetch)).toEqual({
      items: [{ item, memory: undefined }],
      scannedAllMemories: false,
    });
    expect(lists.reads).toEqual([
      "active#0",
      "active#1",
      "active#2",
      ...Array.from({ length: 7 }, (_, index) => `archived#${index}`),
    ]);
  });

  test("an empty queue reads no memories", async () => {
    const lists = memoryLists({ active: [[memory]] });
    expect(await joinReviewMemories([], lists.fetch)).toEqual({
      items: [],
      scannedAllMemories: true,
    });
    expect(lists.reads).toEqual([]);
  });
});
