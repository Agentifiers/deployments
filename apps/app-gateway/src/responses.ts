import type { ServedRole } from "./admission.ts";

export interface Handled {
  readonly databaseError?: string;
  readonly reason?: string;
  readonly response: Response;
  readonly role?: ServedRole;
  readonly rows?: number;
}

function noStoreHeaders(base: Readonly<Record<string, string>>, cookies: readonly string[]) {
  const result = new Headers({ "cache-control": "no-store", ...base });
  for (const cookie of cookies) result.append("set-cookie", cookie);
  return result;
}

export function jsonResponse(
  status: number,
  body: unknown,
  options: { readonly cookies?: readonly string[]; readonly headers?: Record<string, string> } = {},
) {
  return new Response(JSON.stringify(body), {
    headers: noStoreHeaders(
      { "content-type": "application/json; charset=utf-8", ...options.headers },
      options.cookies ?? [],
    ),
    status,
  });
}

export function apiError(
  status: number,
  code: string,
  message: string,
  extraHeaders: Record<string, string> = {},
) {
  return jsonResponse(status, { error: { code, message } }, { headers: extraHeaders });
}

export function htmlResponse(
  status: number,
  html: string,
  cookies: readonly string[] = [],
): Response {
  return new Response(html, {
    headers: noStoreHeaders({ "content-type": "text/html; charset=utf-8" }, cookies),
    status,
  });
}

function escapeHtml(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function platformPage(input: {
  readonly cookies?: readonly string[];
  readonly link?: { readonly href: string; readonly label: string };
  readonly message: string;
  readonly status: number;
  readonly title: string;
}) {
  const link = input.link
    ? `<p><a href="${escapeHtml(input.link.href)}">${escapeHtml(input.link.label)}</a></p>`
    : "";
  return htmlResponse(
    input.status,
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(input.title)}</title></head><body><main><h1>${escapeHtml(input.title)}</h1><p>${escapeHtml(input.message)}</p>${link}</main></body></html>`,
    input.cookies,
  );
}

export function redirect(
  status: 302 | 303 | 307 | 308,
  location: string,
  cookies: readonly string[] = [],
): Response {
  return new Response(null, { headers: noStoreHeaders({ location }, cookies), status });
}

export function emptyResponse(status: 204, cookies: readonly string[] = []): Response {
  return new Response(null, { headers: noStoreHeaders({}, cookies), status });
}
