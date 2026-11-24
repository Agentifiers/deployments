import type { StructuredData } from "fumadocs-core/mdx-plugins";
import { createFromSource } from "fumadocs-core/search/server";
import { source } from "@/lib/source";

const GENERATED_REFERENCE = /^\/docs\/(?:api|cli|sdk)\/reference(?:\/|$)/u;
const MAX_PACKED_ENTRY_LENGTH = 200;

// The index stores per-entry ids, URLs, and token tables, which outweigh the text of a short
// paragraph or table cell, so neighbors under one heading share an entry.
function packContents(contents: StructuredData["contents"]): StructuredData["contents"] {
  const packed: StructuredData["contents"] = [];
  for (const entry of contents) {
    const previous = packed.at(-1);
    if (
      previous !== undefined &&
      previous.heading === entry.heading &&
      previous.content.length + 1 + entry.content.length <= MAX_PACKED_ENTRY_LENGTH
    ) {
      previous.content = `${previous.content} ${entry.content}`;
    } else {
      packed.push({ ...entry });
    }
  }
  return packed;
}

export const revalidate = false;
const search = createFromSource(source, {
  language: "english",
  // The search dialog ranks by relevance only, and per-property sort tables were a quarter of the index.
  sort: { enabled: false },
  buildIndex(page) {
    const { description, structuredData, title } = page.data;
    return {
      id: page.url,
      url: page.url,
      title,
      ...(description === undefined ? {} : { description }),
      structuredData: {
        headings: structuredData.headings,
        // CloudFront compresses only objects up to 10 MB; flag and table rows of the generated reference would push the index past it.
        contents: GENERATED_REFERENCE.test(page.url) ? [] : packContents(structuredData.contents),
      },
    };
  },
});

export const GET = search.staticGET;
