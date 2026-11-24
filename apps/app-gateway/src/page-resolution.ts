import { ReleaseDocumentPath, type AppServing, type ReleaseDocuments } from "@deployments-ai/db";
import { Schema } from "effect";

export const DOCUMENT_EXTENSIONS: readonly string[] = [
  "html",
  "htm",
  "xhtml",
  "svg",
  "xml",
  "xsl",
  "pdf",
];

const decodeDocument = Schema.decodeUnknownSync(ReleaseDocumentPath);
export const INDEX_DOCUMENT = decodeDocument("index.html");
const NOT_FOUND_DOCUMENT = decodeDocument("404.html");

export type PageResolution =
  | { readonly kind: "document"; readonly document: ReleaseDocumentPath }
  | { readonly kind: "canonical"; readonly location: string }
  | { readonly kind: "asset"; readonly path: string }
  | { readonly kind: "not-found"; readonly document: ReleaseDocumentPath | null }
  | { readonly kind: "unknown-documents" };

export function hasDocumentExtension(decodedPath: string): boolean {
  const name = decodedPath.slice(decodedPath.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot !== -1 && DOCUMENT_EXTENSIONS.includes(name.slice(dot + 1).toLowerCase());
}

function decodedSegments(encoded: string): string | null {
  const segments: string[] = [];
  for (const raw of encoded.split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (segment === "" || segment === "." || segment === ".." || /[/\\]/u.test(segment)) {
      return null;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

function listed(documents: ReleaseDocuments, path: string) {
  let low = 0;
  let high = documents.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const candidate = documents[middle]!;
    if (candidate === path) return candidate;
    if (candidate < path) low = middle + 1;
    else high = middle;
  }
  return undefined;
}

export function resolvePage(input: {
  readonly documents: ReleaseDocuments | null;
  readonly pathname: string;
  readonly serving: AppServing;
}): PageResolution {
  const { documents, pathname } = input;
  if (input.serving === "single-page" || pathname === "/") {
    return { document: INDEX_DOCUMENT, kind: "document" };
  }
  if (documents === null) return { kind: "unknown-documents" };
  const notFound: PageResolution = {
    document: listed(documents, NOT_FOUND_DOCUMENT) ?? null,
    kind: "not-found",
  };
  const directory = pathname.endsWith("/");
  const path = decodedSegments(pathname.slice(1, directory ? -1 : undefined));
  if (path === null) return notFound;
  if (directory) {
    const index = listed(documents, `${path}/index.html`);
    if (index) return { document: index, kind: "document" };
    return listed(documents, `${path}.html`)
      ? { kind: "canonical", location: pathname.slice(0, -1) }
      : notFound;
  }
  const document = listed(documents, path) ?? listed(documents, `${path}.html`);
  if (document) return { document, kind: "document" };
  if (listed(documents, `${path}/index.html`)) {
    return { kind: "canonical", location: `${pathname}/` };
  }
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.includes(".") && !hasDocumentExtension(name)
    ? { kind: "asset", path: pathname.slice(1) }
    : notFound;
}
