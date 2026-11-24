/** How the console shows an artifact's bytes on its detail page. */
export type PreviewDecision =
  | { readonly kind: "image" }
  | { readonly kind: "text"; readonly language?: "json" | "markdown" }
  | { readonly kind: "download"; readonly reason: DownloadOnlyReason };

/**
 * `active`: a browser can run script or load content from the file (HTML, SVG, XML, PDF, scripts),
 * so the console never renders it. `binary`: the text preview found bytes that are not text.
 */
export type DownloadOnlyReason =
  | "active"
  | "binary"
  | "not-available"
  | "too-large"
  | "unsupported";

/** Text previews read this much of the file through the signed link and show it as plain text. */
export const PREVIEW_TEXT_BYTES = 256 * 1024;
/** Larger images download instead, so a page view does not pull a large file. */
export const PREVIEW_IMAGE_BYTES = 20 * 1024 * 1024;

const IMAGE_TYPES = new Set(["image/avif", "image/gif", "image/jpeg", "image/png", "image/webp"]);
const TEXT_TYPES: Readonly<Record<string, "json" | "markdown" | undefined>> = {
  "application/json": "json",
  "application/x-ndjson": undefined,
  "text/csv": undefined,
  "text/markdown": "markdown",
  "text/plain": undefined,
  "text/tab-separated-values": undefined,
};
const ACTIVE_TYPES = new Set([
  "application/ecmascript",
  "application/javascript",
  "application/pdf",
  "application/xhtml+xml",
  "application/xml",
  "image/svg+xml",
  "text/ecmascript",
  "text/html",
  "text/javascript",
  "text/xml",
]);

/** The media type without parameters, lowercased: `Text/CSV; charset=utf-8` is `text/csv`. */
export function mediaTypeEssence(contentType: string) {
  return contentType.split(";", 1)[0]!.trim().toLowerCase();
}

export function previewDecision(artifact: {
  readonly byteSize: number;
  readonly contentType: string;
  readonly status: string;
}): PreviewDecision {
  if (artifact.status !== "available") return { kind: "download", reason: "not-available" };
  const essence = mediaTypeEssence(artifact.contentType);
  if (ACTIVE_TYPES.has(essence) || essence.endsWith("+xml")) {
    return { kind: "download", reason: "active" };
  }
  if (IMAGE_TYPES.has(essence)) {
    return artifact.byteSize <= PREVIEW_IMAGE_BYTES
      ? { kind: "image" }
      : { kind: "download", reason: "too-large" };
  }
  if (Object.hasOwn(TEXT_TYPES, essence) || essence.endsWith("+json")) {
    const language = essence.endsWith("+json") ? "json" : TEXT_TYPES[essence];
    return language ? { kind: "text", language } : { kind: "text" };
  }
  return { kind: "download", reason: "unsupported" };
}

export const DOWNLOAD_ONLY_COPY: Readonly<Record<DownloadOnlyReason, string>> = {
  active:
    "The console does not open this kind of file, because a browser can run code from it. Download it to view it.",
  binary: "This file holds bytes that are not text. Download it to view it.",
  "not-available": "The file has no stored bytes yet.",
  "too-large": "This image is too large to preview. Download it to view it.",
  unsupported: "The console has no preview for this kind of file. Download it to view it.",
};
