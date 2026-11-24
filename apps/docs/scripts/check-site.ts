import { join, posix } from "node:path";
import { PUBLIC_API_ROUTES } from "@deployments-ai/api-contract/product";
import { missedSearches } from "./checks/search-index.ts";
import { findLeaks, loadVerticalNameDigests } from "./leak-guard.ts";
import { readManifest } from "./reference/manifest.ts";
import { DOCS_APP_DIRECTORY } from "./reference/urls.ts";
import { loadViewerRequestRewrite } from "./viewer-request.ts";

const OUT_DIRECTORY = join(DOCS_APP_DIRECTORY, "out");
const PUBLISHED_TEXT_FILE = /\.(?:html|json|md|txt|xml)$/u;
const MAX_REPORTED = 40;
const SEARCH_INDEX_FILE = join(OUT_DIRECTORY, "api", "search.json");
const GUIDE_SEARCH = {
  query: "OpenID Connect authorization-code flow with PKCE",
  url: "/docs/getting-started/console",
};

const REQUIRED_CUSTOM_COMMANDS = [
  "deployments auth login",
  "deployments auth logout",
  "deployments context show",
  "deployments context set",
  "deployments context clear",
  "deployments whoami",
  "deployments chat",
  "deployments dev",
  "deployments health",
  "deployments openapi",
  "deployments catalog",
  "deployments tool upload",
  "deployments run tail",
];

const failures = new Map<string, string[]>();
function fail(check: string, message: string) {
  const list = failures.get(check) ?? [];
  list.push(message);
  failures.set(check, list);
}

const viewerRequestUri = loadViewerRequestRewrite();

function cdnObjectPath(href: string): string {
  return decodeURIComponent(viewerRequestUri(href.split(/[?#]/u)[0] ?? ""));
}

function visibleText(html: string): string {
  return html.replaceAll(/<script[\s\S]*?<\/script>/gu, " ").replaceAll(/<[^>]+>/gu, " ");
}

if (!(await Bun.file(join(OUT_DIRECTORY, "index.html")).exists())) {
  console.error(
    `${OUT_DIRECTORY} has no index.html. Run \`bun run --cwd apps/docs build:site\` first.`,
  );
  process.exit(1);
}
const manifest = await readManifest();
const files = Array.from(new Bun.Glob("**/*").scanSync({ cwd: OUT_DIRECTORY, dot: true })).map(
  (file) => `/${file.split("\\").join("/")}`,
);
const fileSet = new Set(files);
const htmlFiles = files.filter((file) => file.endsWith(".html"));
const read = (file: string) => Bun.file(join(OUT_DIRECTORY, file)).text();

const apiPages = htmlFiles.filter((file) =>
  /^\/docs\/api\/reference\/[^/]+\/[^/]+\/index\.html$/u.test(file),
);
if (apiPages.length !== PUBLIC_API_ROUTES.length) {
  fail(
    "P2 API operation pages",
    `${apiPages.length} operation pages for ${PUBLIC_API_ROUTES.length} PUBLIC_API_ROUTES entries.`,
  );
}
for (const operation of manifest.operations) {
  const page = cdnObjectPath(operation.url);
  if (!fileSet.has(page)) {
    fail("P2 API operation pages", `${operation.name}: ${page} was not exported.`);
    continue;
  }
  const html = await read(page);
  if (
    !html.includes(`await ${operation.name}({`) ||
    !visibleText(html).includes("TypeScript SDK")
  ) {
    fail("P4 API code samples", `${page}: no TypeScript SDK sample calling ${operation.name}.`);
  }
  for (const command of operation.cliCommands) {
    if (!html.includes(command))
      fail("P4 API code samples", `${page}: no CLI sample for \`${command}\`.`);
  }
}

const cliText = (
  await Promise.all(htmlFiles.filter((file) => file.startsWith("/docs/cli/reference/")).map(read))
)
  .map(visibleText)
  .join("\n");
const leafCommands = manifest.cliCommands
  .filter((command) => command.leaf)
  .map((command) => command.command);
for (const command of new Set([...leafCommands, ...REQUIRED_CUSTOM_COMMANDS])) {
  if (!leafCommands.includes(command))
    fail("P3 CLI reference", `\`${command}\` is missing from the CLI command tree.`);
  if (!cliText.includes(command))
    fail("P3 CLI reference", `\`${command}\` does not appear in the built CLI reference.`);
}

const verticalNameDigests = await loadVerticalNameDigests();
const scannedContents = new Set<string>();
for (const file of files.filter((candidate) => PUBLISHED_TEXT_FILE.test(candidate))) {
  const text = await read(file);
  const digest = Bun.hash(text).toString(16);
  if (scannedContents.has(digest)) continue;
  scannedContents.add(digest);
  for (const leak of findLeaks(text, verticalNameDigests)) {
    fail(
      `P6 leak guard: ${leak.kind}`,
      `${file}:${leak.line}:${leak.column} \`${leak.match.slice(0, 80)}\``,
    );
  }
}

for (const file of htmlFiles) {
  const html = await read(file);
  for (const match of html.matchAll(/<[a-z][^>]*?\s(?:href|src)="([^"]*)"/giu)) {
    const target = (match[1] ?? "").replaceAll("&amp;", "&");
    if (
      target === "" ||
      target.startsWith("#") ||
      target.startsWith("//") ||
      /^[a-z][a-z0-9+.-]*:/iu.test(target)
    ) {
      continue;
    }
    const absolute = target.startsWith("/") ? target : posix.join(posix.dirname(file), target);
    const servedFile = cdnObjectPath(absolute);
    if (!fileSet.has(servedFile)) {
      fail("P7 internal links", `${file}: \`${target}\` resolves to missing ${servedFile}.`);
    }
  }
}

const CLOUDFRONT_MAX_COMPRESSED_BYTES = 10_000_000;
for (const file of files.filter((candidate) =>
  /\.(?:html|txt|json|xml|js|css|svg)$/u.test(candidate),
)) {
  const bytes = Bun.file(join(OUT_DIRECTORY, file)).size;
  if (bytes > CLOUDFRONT_MAX_COMPRESSED_BYTES) {
    fail(
      "Compressible size",
      `${file} is ${bytes} bytes; CloudFront serves files over ${CLOUDFRONT_MAX_COMPRESSED_BYTES} bytes uncompressed.`,
    );
  }
}

const searchIndexBytes = Bun.file(SEARCH_INDEX_FILE).size;
const searchExpectations = [
  GUIDE_SEARCH,
  ...manifest.operations.flatMap((operation) => [
    { query: operation.name, url: operation.url },
    { query: operation.summary, url: operation.url },
  ]),
];
for (const { query, url } of await missedSearches(SEARCH_INDEX_FILE, searchExpectations)) {
  fail("Search", `Searching "${query}" does not return ${url}.`);
}

console.log(
  `Checked ${htmlFiles.length} HTML files, ${apiPages.length} API operation pages, ${leafCommands.length} CLI commands, ${scannedContents.size} distinct text files, and ${searchExpectations.length} searches of the ${searchIndexBytes}-byte search index.`,
);
for (const check of [
  "P2 API operation pages",
  "P3 CLI reference",
  "P4 API code samples",
  "P6 leak guard",
  "P7 internal links",
  "Compressible size",
  "Search",
]) {
  const groups = [...failures].filter(([name]) => name.startsWith(check));
  if (groups.length === 0) console.log(`PASS ${check}`);
  for (const [name, messages] of groups) {
    console.log(`FAIL ${name} (${messages.length})`);
    for (const message of messages.slice(0, MAX_REPORTED)) console.log(`  ${message}`);
    if (messages.length > MAX_REPORTED) console.log(`  … ${messages.length - MAX_REPORTED} more`);
  }
}
if (failures.size > 0) process.exit(1);
