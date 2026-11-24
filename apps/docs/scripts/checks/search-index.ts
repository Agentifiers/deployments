import { pathToFileURL } from "node:url";
import { staticClient } from "fumadocs-core/search/client/orama-static";
import { normalizeDocsPath } from "../reference/urls.ts";

export interface SearchExpectation {
  readonly query: string;
  readonly url: string;
}

export async function missedSearches(
  indexFile: string,
  expectations: readonly SearchExpectation[],
): Promise<SearchExpectation[]> {
  const client = staticClient({ from: pathToFileURL(indexFile).href });
  const missed: SearchExpectation[] = [];
  for (const expectation of expectations) {
    const results = await client.search(expectation.query);
    const expectedUrl = normalizeDocsPath(expectation.url);
    if (!results.some((result) => result.type === "page" && result.url === expectedUrl)) {
      missed.push(expectation);
    }
  }
  return missed;
}
