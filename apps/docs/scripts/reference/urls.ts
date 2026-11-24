import { join } from "node:path";

export const DOCS_APP_DIRECTORY = join(import.meta.dir, "..", "..");
export const CONTENT_DIRECTORY = join(DOCS_APP_DIRECTORY, "content", "docs");
export const GENERATED_DIRECTORY = join(DOCS_APP_DIRECTORY, "generated");
export const MANIFEST_PATH = join(GENERATED_DIRECTORY, "manifest.json");
export const OPENAPI_PATH = join(GENERATED_DIRECTORY, "openapi.json");

export const GENERATED_CONTENT = {
  apiReference: "api/reference",
  cliReference: "cli/reference",
  sdkReference: "sdk/reference.mdx",
} as const;

export function slugify(text: string): string {
  return text
    .replaceAll(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .replaceAll(/([A-Z]+)([A-Z][a-z])/gu, "$1-$2")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-|-$/gu, "");
}

export function apiOperationSlug(operation: {
  readonly tag: string;
  readonly name: string;
}): string {
  return `${slugify(operation.tag)}/${slugify(operation.name)}`;
}

export function apiOperationUrl(operation: {
  readonly tag: string;
  readonly name: string;
}): string {
  return `/docs/${GENERATED_CONTENT.apiReference}/${apiOperationSlug(operation)}/`;
}

export function cliPageUrl(topLevelCommand: string): string {
  return `/docs/${GENERATED_CONTENT.cliReference}/${topLevelCommand}/`;
}

export function cliCommandAnchor(path: readonly string[]): string {
  return path.join("-");
}

export function cliCommandUrl(path: readonly [string, ...string[]]): string {
  return `${cliPageUrl(path[0])}#${cliCommandAnchor(path)}`;
}

export function sdkReferenceUrl(tag?: string): string {
  return `/docs/sdk/reference/${tag ? `#${slugify(tag)}` : ""}`;
}

export type DocsPath = string & { readonly __brand: "DocsPath" };

export function normalizeDocsPath(href: string): DocsPath {
  const [path = ""] = href.split(/[?#]/u);
  return (path.length > 1 ? path.replace(/\/+$/u, "") : path) as DocsPath;
}
