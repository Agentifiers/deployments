import { llms, loader } from "fumadocs-core/source";
import { defineDocs } from "fumadocs-mdx/macro";
import { apiMethodBadges } from "@/lib/api-method-badges";

const docs = defineDocs({
  dir: "content/docs",
  docs: { postprocess: { includeProcessedMarkdown: true } },
});

export const source = loader({
  baseUrl: "/docs",
  source: docs.toFumadocsSource(),
  plugins: [apiMethodBadges()],
  pageTree: {
    noRef: true,
    transformers: [
      {
        file({ description: _sidebarHidesDescriptions, ...node }) {
          return node;
        },
      },
    ],
  },
});

export const docsLlms = llms(source, {
  async renderPage(page) {
    const isApiReference = "_openapi" in page.data && page.data._openapi !== undefined;
    return [
      `# ${page.data.title} (${page.url})`,
      page.data.description ?? "",
      isApiReference ? "" : await page.data.getText("processed"),
    ]
      .filter((section) => section.length > 0)
      .join("\n\n");
  },
});
