export interface RestApiResponse {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly isBase64Encoded: false;
  readonly multiValueHeaders?: Readonly<Record<string, readonly string[]>>;
  readonly statusCode: number;
}

export function securityHeaders(contentType = "application/json; charset=utf-8") {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    "Content-Type": contentType,
    "Referrer-Policy": "no-referrer",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

export function json(
  statusCode: number,
  value: unknown,
  extraHeaders: Record<string, string> = {},
): RestApiResponse {
  return {
    body: JSON.stringify(value),
    headers: { ...securityHeaders(), ...extraHeaders },
    isBase64Encoded: false,
    statusCode,
  };
}

export function empty(
  statusCode: number,
  extraHeaders: Record<string, string> = {},
): RestApiResponse {
  return {
    body: "",
    headers: { ...securityHeaders(), ...extraHeaders },
    isBase64Encoded: false,
    statusCode,
  };
}

/** A cookie sent on cross-site requests must be Secure, so `sameSite: "none"` demands it. */
export type CookieAttributes = { readonly httpOnly: boolean; readonly maxAge: number } & (
  | { readonly sameSite?: "lax"; readonly secure: boolean }
  | { readonly sameSite: "none"; readonly secure: true }
);

export function cookie(name: string, value: string, input: CookieAttributes) {
  return `${name}=${value}; Path=/; Max-Age=${input.maxAge}; SameSite=${input.sameSite === "none" ? "None" : "Lax"}${input.secure ? "; Secure" : ""}${input.httpOnly ? "; HttpOnly" : ""}`;
}

export function redirect(location: string, statusCode: 302 | 303 = 302): RestApiResponse {
  return {
    body: "",
    headers: { ...securityHeaders(), Location: location },
    isBase64Encoded: false,
    statusCode,
  };
}
