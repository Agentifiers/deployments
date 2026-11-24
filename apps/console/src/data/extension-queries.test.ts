import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { extensionPagesQuery, invalidateExtensions } from "./extension-queries.ts";
import { extensionDirectoryQuery } from "./tool-directory-queries.ts";

const SCOPE = {
  environmentId: "01M4CGXP4MSH02TQKZC4HB0CEA",
  organizationId: "01M4CGXP4MSH02TQKZC4HB0CEB",
  projectId: "01M4CGXP4MSH02TQKZC4HB0CEC",
};

describe("invalidateExtensions", () => {
  test("an extension write marks both the extension list and the Tools tab's directory stale", async () => {
    const queryClient = new QueryClient();
    const pages = extensionPagesQuery(SCOPE, {}).queryKey;
    const directory = extensionDirectoryQuery(SCOPE).queryKey;
    queryClient.setQueryData(pages, { pageParams: [], pages: [] });
    queryClient.setQueryData(directory, { complete: true, extensions: [] });
    const keys = [pages, directory];
    await invalidateExtensions(queryClient, SCOPE);
    expect(keys.map((queryKey) => queryClient.getQueryState(queryKey)?.isInvalidated)).toEqual([
      true,
      true,
    ]);
  });
});
