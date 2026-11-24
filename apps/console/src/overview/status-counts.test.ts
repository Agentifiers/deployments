import { expect, test } from "bun:test";
import {
  collectPagesUpTo,
  countPages,
  formatCount,
  tallyPages,
  type FetchPage,
} from "./status-counts.ts";

/** Serves fixed pages; page `n` links to `n + 1` until the last. */
function pages<Item>(contents: readonly (readonly Item[])[]): {
  fetchPage: FetchPage<Item>;
  requests: () => number;
} {
  let requests = 0;
  return {
    fetchPage: async (cursor) => {
      requests += 1;
      const index = cursor === undefined ? 0 : Number(cursor);
      return {
        items: contents[index] ?? [],
        nextCursor: index + 1 < contents.length ? String(index + 1) : null,
      };
    },
    requests: () => requests,
  };
}

test("tallies follow every page within the budget and skip unknown keys", async () => {
  const source = pages([["ready", "paused"], ["ready", "archived"], ["stopped"]]);
  const tally = await tallyPages(["ready", "paused", "stopped"], source.fetchPage, (s) => s, 5);
  expect(tally).toEqual({ complete: true, counts: { paused: 1, ready: 2, stopped: 1 } });
  const truncated = await tallyPages(
    ["ready"],
    pages([["ready"], ["ready"]]).fetchPage,
    (s) => s,
    1,
  );
  expect(truncated).toEqual({ complete: false, counts: { ready: 1 } });
});

test("capped counts follow short filtered pages and stop at the cap", async () => {
  // Filtered lists may return short or empty pages that still carry a cursor.
  const short = pages([[1], [], [2, 3]]);
  expect(await countPages(short.fetchPage, 100, 10)).toEqual({ complete: true, count: 3 });
  const many = pages([Array.from({ length: 60 }), Array.from({ length: 60 }), [1]]);
  expect(await countPages(many.fetchPage, 100, 10)).toEqual({ complete: false, count: 100 });
  expect(many.requests()).toBe(2);
  // Reaching the cap on the last page is still an exact count.
  expect(await countPages(pages([Array.from({ length: 100 })]).fetchPage, 100, 10)).toEqual({
    complete: true,
    count: 100,
  });
  expect(await countPages(pages([[1], [2], [3]]).fetchPage, 100, 2)).toEqual({
    complete: false,
    count: 2,
  });
});

test("a repeated cursor fails instead of looping", async () => {
  const loop: FetchPage<number> = async () => ({ items: [1], nextCursor: "same" });
  expect(countPages(loop, 100, 10)).rejects.toThrow("repeated a pagination cursor");
});

test("lower bounds render with a plus", () => {
  expect(formatCount(100, false)).toBe("100+");
  expect(formatCount(1_234, true)).toBe("1,234");
});

test("capped collection keeps the pages it read and says whether the list ended", async () => {
  expect(await collectPagesUpTo(pages([["a"], [], ["b", "c"]]).fetchPage, 5)).toEqual({
    complete: true,
    items: ["a", "b", "c"],
  });
  expect(await collectPagesUpTo(pages([["a"], ["b"], ["c"]]).fetchPage, 2)).toEqual({
    complete: false,
    items: ["a", "b"],
  });
});
