import { describe, expect, test } from "bun:test";
import { ListToolsResponse, ToolCatalogDetailResponse } from "@deployments-ai/api-contract";
import { PersistenceError } from "@deployments-ai/db";
import { platformToolAdapterDefinitions } from "@deployments-ai/tools";
import { Schema } from "effect";
import {
  parseToolListFilters,
  toolCatalogDetail,
  toolCatalogPage,
} from "./tool-catalog-listing.ts";

function page(query: string, cursor?: string, limit = 100) {
  return Schema.decodeUnknownSync(ListToolsResponse)(
    toolCatalogPage({
      ...(cursor ? { cursor } : {}),
      filters: parseToolListFilters(new URLSearchParams(query)),
      limit,
    }),
  );
}

function allPages(query: string, limit: number) {
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const result = page(query, cursor, limit);
    names.push(...result.items.map((item) => item.name));
    cursor = result.nextCursor ?? undefined;
  } while (cursor);
  return names;
}

const activeNames = platformToolAdapterDefinitions
  .filter((definition) => definition.status === "active")
  .map((definition) => definition.toolName)
  .toSorted();
const archivedNames = platformToolAdapterDefinitions
  .filter((definition) => definition.status === "archived")
  .map((definition) => definition.toolName)
  .toSorted();

describe("platform tool catalog listing", () => {
  test("lists only active tools by default, in name order across pages", () => {
    expect(allPages("", 7)).toEqual(activeNames);
    expect(page("").items.every((item) => item.status === "active")).toBe(true);
  });

  test("lists archived tools only when requested, flagged as archived", () => {
    const archived = page("status=archived").items;
    expect(archived.map((item) => item.name)).toEqual(archivedNames);
    expect(archived.every((item) => item.status === "archived")).toBe(true);
    expect(allPages("status=all", 50)).toEqual([...activeNames, ...archivedNames].toSorted());
  });

  test("filters by provider key, prefix, and case-insensitive search", () => {
    const shopify = page("providerKey=shopify").items;
    expect(shopify.length).toBeGreaterThan(0);
    expect(shopify.every((item) => item.providerKey === "shopify")).toBe(true);
    expect(shopify.find((item) => item.name === "shopify.fulfillments.create")).toMatchObject({
      approvalRequired: true,
      defaultPolicyAction: "require_approval",
      policyBinding: "connection",
      requiredScopes: ["write_fulfillments"],
    });
    expect(page("prefix=shopify.orders.").items.map((item) => item.name)).toEqual([
      "shopify.orders.search",
    ]);
    expect(page("search=ARTIFACT.INSPECT").items.map((item) => item.name)).toEqual([
      "artifact.inspect",
    ]);
    expect(page("search=artifact.inspect").items[0]).toMatchObject({
      category: "platform",
      policyBinding: "catalog",
      route: "builtin",
    });
    expect(page("providerKey=shopify&status=archived").items).toEqual([]);
  });

  test("rejects invalid filters and cursors", () => {
    for (const query of ["status=deleted", "prefix=", `search=${"x".repeat(101)}`]) {
      expect(() => parseToolListFilters(new URLSearchParams(query))).toThrow(PersistenceError);
    }
    expect(() => page("", "not a cursor")).toThrow(PersistenceError);
  });

  test("returns schemas on the detail, including archived tools, and 404s unknown tools", () => {
    const detail = Schema.decodeUnknownSync(ToolCatalogDetailResponse)(
      toolCatalogDetail("shopify.products.search"),
    );
    expect(detail.inputSchema).toMatchObject({ type: "object" });
    expect(toolCatalogDetail(archivedNames[0]!).status).toBe("archived");
    expect(() => toolCatalogDetail("custom.unknown")).toThrow(
      expect.objectContaining({ kind: "not-found" }),
    );
  });
});
