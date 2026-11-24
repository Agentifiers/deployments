/** API Gateway HTTP API (payload format 2.0) event fields the console reads. */
export interface HttpApiEvent {
  readonly body?: string;
  readonly cookies?: readonly string[];
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly isBase64Encoded?: boolean;
  readonly rawPath: string;
  readonly rawQueryString?: string;
  readonly requestContext: {
    readonly domainName?: string;
    readonly http: { readonly method: string };
  };
}

export interface HttpApiResult {
  readonly body: string;
  readonly cookies?: readonly string[];
  readonly headers: Readonly<Record<string, string>>;
  readonly isBase64Encoded: boolean;
  readonly statusCode: number;
}

/**
 * Builds the web request on the browser-facing origin. CloudFront forwards to API Gateway
 * without the viewer `Host`, so the event's host is the execute-api domain; absolute URLs Start
 * derives (redirects, server functions) must use `publicOrigin` instead. Payload 2.0 cookies
 * are restored as one RFC 6265 `cookie` header.
 */
export function httpApiRequest(event: HttpApiEvent, publicOrigin: string): Request {
  // Concatenate rather than resolve: a raw path such as `//other.example` must stay a path.
  const query = event.rawQueryString ? `?${event.rawQueryString}` : "";
  const url = new URL(`${publicOrigin}${event.rawPath}${query}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(event.headers ?? {})) {
    if (value !== undefined) headers.set(name, value);
  }
  headers.set("host", url.host);
  headers.delete("x-forwarded-host");
  if (event.cookies && event.cookies.length > 0) headers.set("cookie", event.cookies.join("; "));

  const method = event.requestContext.http.method;
  const body =
    event.body === undefined || method === "GET" || method === "HEAD"
      ? undefined
      : event.isBase64Encoded
        ? Buffer.from(event.body, "base64")
        : event.body;
  return new Request(url, { headers, method, ...(body === undefined ? {} : { body }) });
}

/** Returns each `Set-Cookie` only through `cookies`, never as a comma-joined header. */
export async function httpApiResult(response: Response): Promise<HttpApiResult> {
  const headers: Record<string, string> = {};
  for (const [name, value] of response.headers) {
    if (name !== "set-cookie") headers[name] = value;
  }
  const cookies = response.headers.getSetCookie();
  const payload = Buffer.from(await response.arrayBuffer());
  const text = /^text\/|\/(?:javascript|json|xml)|\+json|utf-?8/iu.test(
    response.headers.get("content-type") ?? "",
  );
  return {
    body: payload.toString(text ? "utf8" : "base64"),
    headers,
    isBase64Encoded: !text,
    statusCode: response.status,
    ...(cookies.length > 0 ? { cookies } : {}),
  };
}
