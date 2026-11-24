/**
 * Opaque BFF cookies. Both use the `__Host-` prefix, so browsers bind them to the exact host
 * (no `Domain`), require `Secure`, and require `Path=/`. Neither is readable by JavaScript.
 */
export const WEB_BFF_SESSION_COOKIE = "__Host-deployments-session";
export const WEB_BFF_TRANSACTION_COOKIE = "__Host-deployments-authorization";

/** Serializes one host-only `HttpOnly; Secure; SameSite=Lax` cookie; `maxAgeSeconds: 0` clears it. */
export function serializeBffCookie(name: string, value: string, maxAgeSeconds: number) {
  return `${name}=${value}; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

/**
 * Returns the value of `name` from a `Cookie` header. A duplicated name is ambiguous (a sibling
 * host or path could have planted one), so it is treated as absent. Pairs are split on `;` and
 * also on `,`: API Gateway HTTP API (v2) delivers cookies as an array that the Lambda adapter
 * re-joins with `Headers.append`, i.e. with `, `. RFC 6265 cookie values never contain commas.
 */
export function readCookie(header: string | null | undefined, name: string) {
  if (!header) return undefined;
  const values = header
    .split(/[;,]/u)
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
  return values.length === 1 && values[0] ? values[0] : undefined;
}
