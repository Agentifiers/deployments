import type { AppServing, ReleaseDocumentPath, Ulid } from "@deployments-ai/db";
import { renderStaticSite } from "./static-site-html.ts";

export const RENDERED_PAGE_CACHE_BYTES = 64 * 1024 * 1024;

export interface ReleaseFiles {
  readonly document: (input: {
    readonly appId: Ulid;
    readonly document: ReleaseDocumentPath;
    readonly releaseId: Ulid;
  }) => Promise<string | undefined>;
}

export interface RenderedPageInput {
  readonly appId: Ulid;
  readonly document: ReleaseDocumentPath;
  readonly releaseId: Ulid;
  readonly serving: AppServing;
}

export type RenderedPages = (input: RenderedPageInput) => Promise<string | undefined>;

const HEAD_OPEN = /<head(?:\s[^>]*)?>/iu;
const DOCTYPE = /^\s*<!doctype[^>]*>/iu;

/** Inserted first in `<head>` because the first `<base href>` in a document wins. */
export function withBaseHref(html: string, releaseId: Ulid) {
  const base = `<base href="/_r/${releaseId}/">`;
  const anchor = HEAD_OPEN.exec(html) ?? DOCTYPE.exec(html);
  if (!anchor) return `${base}${html}`;
  const at = anchor.index + anchor[0].length;
  return `${html.slice(0, at)}${base}${html.slice(at)}`;
}

export function renderedPages(input: {
  readonly maxBytes: number;
  readonly releases: ReleaseFiles;
}): RenderedPages {
  const entries = new Map<string, string>();
  let bytes = 0;
  return async (page) => {
    const key = `${page.releaseId}\u0000${page.serving}\u0000${page.document}`;
    const cached = entries.get(key);
    if (cached !== undefined) {
      entries.delete(key);
      entries.set(key, cached);
      return cached;
    }
    const html = await input.releases.document(page);
    if (html === undefined) return undefined;
    const rendered =
      page.serving === "single-page"
        ? withBaseHref(html, page.releaseId)
        : renderStaticSite(html, { document: page.document, releaseId: page.releaseId });
    const size = rendered.length * 2;
    if (size > input.maxBytes || entries.has(key)) return rendered;
    for (const [oldest, value] of entries) {
      if (bytes + size <= input.maxBytes) break;
      entries.delete(oldest);
      bytes -= value.length * 2;
    }
    entries.set(key, rendered);
    bytes += size;
    return rendered;
  };
}
