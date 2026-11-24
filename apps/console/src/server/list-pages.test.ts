import { describe, expect, test } from "bun:test";
import { fillPage, type Page } from "./list-pages.ts";

function pagedApi(pages: Readonly<Record<string, Page<number>>>) {
  const requests: { readonly cursor: string | undefined; readonly limit: number }[] = [];
  const fetchPage = async (cursor: string | undefined, limit: number) => {
    requests.push({ cursor, limit });
    return pages[cursor ?? "first"]!;
  };
  return { fetchPage, requests };
}

describe("fillPage", () => {
  test("follows short filtered pages until the screen is full", async () => {
    const api = pagedApi({
      a: { items: [], nextCursor: "b" },
      b: { items: [3, 4, 5], nextCursor: "c" },
      first: { items: [1, 2], nextCursor: "a" },
    });

    expect(await fillPage(api.fetchPage, undefined, 4)).toEqual({
      items: [1, 2, 3, 4, 5],
      nextCursor: "c",
    });
    expect(api.requests).toEqual([
      { cursor: undefined, limit: 4 },
      { cursor: "a", limit: 2 },
      { cursor: "b", limit: 2 },
    ]);
  });

  test("omits the cursor when the list ended", async () => {
    const api = pagedApi({ first: { items: [1] } });

    expect(await fillPage(api.fetchPage, undefined, 50)).toEqual({ items: [1] });
  });

  test("stops after the request cap and hands back the cursor, even with no items", async () => {
    const api = pagedApi({
      a: { items: [], nextCursor: "b" },
      b: { items: [], nextCursor: "c" },
      first: { items: [], nextCursor: "a" },
    });

    expect(await fillPage(api.fetchPage, undefined, 50, 3)).toEqual({ items: [], nextCursor: "c" });
    expect(api.requests).toHaveLength(3);
  });

  test("refuses a cursor the API already returned", async () => {
    const api = pagedApi({
      a: { items: [], nextCursor: "a" },
      first: { items: [], nextCursor: "a" },
    });

    const failure = await fillPage(api.fetchPage, undefined, 50).catch((error: unknown) => error);

    expect(failure).toHaveProperty("message", "The platform API repeated a pagination cursor.");
  });
});
