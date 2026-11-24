import type { ReleaseDocumentPath, Ulid } from "@deployments-ai/db";
import { decodeHTMLAttribute, escapeAttribute } from "entities";
import { hasDocumentExtension } from "./page-resolution.ts";

const RELEASE_ORIGIN = "https://release.invalid";
const SCHEME = /^[a-z][a-z0-9+.-]*:/iu;
const PLATFORM_PATH = /^\/(?:_platform(?:\/|$)|_r\/)/u;
const ASCII_WHITESPACE = /[\t\n\f\r ]/u;
const ASCII_WHITESPACE_RUN = /[\t\n\f\r ]+/u;
const ASCII_WHITESPACE_OR_COMMA = /[\t\n\f\r ,]/u;
const ASCII_WHITESPACE_EDGES = /^[\t\n\f\r ]+|[\t\n\f\r ]+$/gu;
const SUBRESOURCE_LINK_RELS: Readonly<Record<string, true>> = {
  icon: true,
  manifest: true,
  modulepreload: true,
  preload: true,
  stylesheet: true,
};

function safeDecode(path: string) {
  try {
    return decodeURIComponent(path);
  } catch {
    return null;
  }
}

/** Splits a `srcset` into candidates without breaking a URL that contains a comma. HTML separates on ASCII whitespace only, so a Unicode space stays inside the URL. */
function rewriteSrcset(srcset: string, rewrite: (url: string) => string) {
  const candidates: string[] = [];
  let at = 0;
  while (at < srcset.length) {
    while (at < srcset.length && ASCII_WHITESPACE_OR_COMMA.test(srcset[at]!)) at += 1;
    if (at === srcset.length) break;
    const start = at;
    while (at < srcset.length && !ASCII_WHITESPACE.test(srcset[at]!)) at += 1;
    let url = srcset.slice(start, at);
    let descriptor = "";
    if (url.endsWith(",")) {
      url = url.replace(/,+$/u, "");
    } else {
      const descriptorStart = at;
      while (at < srcset.length && srcset[at] !== ",") at += 1;
      descriptor = srcset.slice(descriptorStart, at).replace(ASCII_WHITESPACE_EDGES, "");
    }
    candidates.push(descriptor === "" ? rewrite(url) : `${rewrite(url)} ${descriptor}`);
  }
  return candidates.join(", ");
}

/** HTMLRewriter reads and writes attribute values raw, so each value is decoded before it is resolved and escaped when it is written. */
export function renderStaticSite(
  html: string,
  input: { readonly document: ReleaseDocumentPath; readonly releaseId: Ulid },
): string {
  const directory = input.document.slice(0, input.document.lastIndexOf("/") + 1);
  const base = `${RELEASE_ORIGIN}/${directory.split("/").map(encodeURIComponent).join("/")}`;
  const asset = (reference: string) => {
    const value = reference.replace(ASCII_WHITESPACE_EDGES, "");
    if (value === "" || value.startsWith("#") || SCHEME.test(value)) return reference;
    const url = URL.parse(value, base);
    if (url?.origin !== RELEASE_ORIGIN || PLATFORM_PATH.test(url.pathname)) return reference;
    const decoded = safeDecode(url.pathname);
    if (decoded === null || hasDocumentExtension(decoded)) return reference;
    return `/_r/${input.releaseId}${url.pathname}${url.search}${url.hash}`;
  };
  const rewriteAttribute = (
    element: HTMLRewriterTypes.Element,
    name: string,
    rewrite: (value: string) => string,
  ) => {
    const raw = element.getAttribute(name);
    if (raw === null) return;
    const value = decodeHTMLAttribute(raw);
    const rewritten = rewrite(value);
    if (rewritten !== value) element.setAttribute(name, escapeAttribute(rewritten));
  };
  return new HTMLRewriter()
    .on("base", {
      element(element) {
        element.remove();
      },
    })
    .on("[src]", { element: (element) => rewriteAttribute(element, "src", asset) })
    .on("[poster]", { element: (element) => rewriteAttribute(element, "poster", asset) })
    .on("[srcset]", {
      element: (element) =>
        rewriteAttribute(element, "srcset", (value) => rewriteSrcset(value, asset)),
    })
    .on("link[href][rel]", {
      element(element) {
        const rel = decodeHTMLAttribute(element.getAttribute("rel") ?? "")
          .toLowerCase()
          .split(ASCII_WHITESPACE_RUN);
        if (rel.some((token) => Object.hasOwn(SUBRESOURCE_LINK_RELS, token))) {
          rewriteAttribute(element, "href", asset);
        }
      },
    })
    .transform(html);
}
