import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { generateFilesOnly } from "fumadocs-openapi";
import { createOpenAPI } from "fumadocs-openapi/server";
import { apiReferenceIndexPage } from "./reference/api-index-page.ts";
import { cliReferencePages, type GeneratedPage } from "./reference/cli-pages.ts";
import { readCliTree } from "./reference/cli-tree.ts";
import { buildManifest } from "./reference/manifest.ts";
import { buildDocsOpenApi } from "./reference/openapi-document.ts";
import { buildOperations } from "./reference/operations.ts";
import { sdkReferencePage } from "./reference/sdk-page.ts";
import {
  CONTENT_DIRECTORY,
  GENERATED_CONTENT,
  GENERATED_DIRECTORY,
  MANIFEST_PATH,
  OPENAPI_PATH,
  apiOperationSlug,
  cliPageUrl,
  sdkReferenceUrl,
  slugify,
} from "./reference/urls.ts";

async function writePages(directory: string, pages: readonly GeneratedPage[]) {
  await Promise.all(
    pages.map(async (page) => {
      const target = join(directory, page.contentPath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, page.content);
    }),
  );
}

const started = performance.now();
const tree = await readCliTree();
const operations = buildOperations(tree);
const document = buildDocsOpenApi(operations);

await Promise.all(
  [
    GENERATED_DIRECTORY,
    ...Object.values(GENERATED_CONTENT).map((path) => join(CONTENT_DIRECTORY, path)),
  ].map((path) => rm(path, { recursive: true, force: true })),
);
await mkdir(GENERATED_DIRECTORY, { recursive: true });
await writeFile(OPENAPI_PATH, `${JSON.stringify(document, null, 2)}\n`);

const operationsById = new Map(operations.map((operation) => [operation.route.name, operation]));
const apiFiles = await generateFilesOnly({
  input: createOpenAPI({ input: { public: OPENAPI_PATH } }),
  per: "operation",
  includeDescription: true,
  addGeneratedComment: false,
  name(output) {
    if (output.type !== "operation")
      throw new Error("The public API document declares no webhooks.");
    const operationId = document.paths[output.item.path]?.[output.item.method]?.operationId ?? "";
    const operation = operationsById.get(operationId);
    if (!operation) throw new Error(`Generated page for unknown operation ${operationId}.`);
    return apiOperationSlug(operation.route);
  },
});
if (apiFiles.length !== operations.length) {
  throw new Error(`Generated ${apiFiles.length} API pages for ${operations.length} operations.`);
}
const operationsByFile = new Map(
  operations.map((operation) => [`${apiOperationSlug(operation.route)}.mdx`, operation]),
);
const tags = [...new Set(operations.map((operation) => operation.route.tag))].toSorted();
const apiPages: GeneratedPage[] = [
  ...apiFiles.map((file) => {
    const operation = operationsByFile.get(file.path);
    if (!operation) throw new Error(`Generated API page ${file.path} matches no operation.`);
    const description = [
      operation.endpoint,
      `SDK ${operation.route.name}`,
      `CLI ${[...new Set(operation.cli.map((command) => command.command))].join(", ")}`,
    ].join(" · ");
    return {
      contentPath: file.path,
      content: file.content.replace(
        /^---\n/u,
        `---\ndescription: ${JSON.stringify(description)}\n`,
      ),
    };
  }),
  apiReferenceIndexPage(operations),
  {
    contentPath: "meta.json",
    content: `${JSON.stringify({ title: "Reference", pages: tags.map(slugify) }, null, 2)}\n`,
  },
  ...tags.map((tag) => ({
    contentPath: `${slugify(tag)}/meta.json`,
    content: `${JSON.stringify({ title: tag }, null, 2)}\n`,
  })),
];
const cliPages = cliReferencePages(tree, operations);
const sdkPage = sdkReferencePage(operations);

const manifest = buildManifest({
  tree,
  operations,
  pageUrls: [
    ...operations.map((operation) => operation.url),
    ...cliPages
      .filter((page) => page.contentPath.endsWith(".mdx"))
      .map((page) =>
        page.contentPath === "index.mdx"
          ? "/docs/cli/reference/"
          : cliPageUrl(page.contentPath.replace(/\.mdx$/u, "")),
      ),
    sdkReferenceUrl(),
  ],
});

await Promise.all([
  writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`),
  writePages(join(CONTENT_DIRECTORY, GENERATED_CONTENT.apiReference), apiPages),
  writePages(join(CONTENT_DIRECTORY, GENERATED_CONTENT.cliReference), cliPages),
  writePages(dirname(join(CONTENT_DIRECTORY, GENERATED_CONTENT.sdkReference)), [sdkPage]),
]);

console.log(
  `Generated ${operations.length} API operation pages, ${cliPages.length - 1} CLI reference files (${manifest.cliCommands.length} commands and groups), and the SDK function index in ${Math.round(performance.now() - started)} ms.`,
);
