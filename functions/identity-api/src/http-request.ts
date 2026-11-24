import { IdentityError } from "@deployments-ai/identity";
import type { RestApiEvent } from "./http.ts";

const DEFAULT_BODY_BYTE_LIMIT = 16_384;

export function header(event: RestApiEvent, name: string) {
  const match = Object.entries(event.headers ?? {}).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  );
  return match?.[1];
}

export function cookies(event: RestApiEvent) {
  return Object.fromEntries(
    (header(event, "cookie") ?? "")
      .split(";")
      .map((value) => value.trim().split("=", 2))
      .filter((pair): pair is [string, string] => pair.length === 2 && Boolean(pair[0])),
  );
}

function assertBodyWithin(event: RestApiEvent, maxBytes: number) {
  if ((event.body?.length ?? 0) > maxBytes) {
    throw new IdentityError("invalid_request", "Request body is too large.", {
      status: 413,
    });
  }
}

function contentType(event: RestApiEvent) {
  return header(event, "content-type")?.split(";", 1)[0]?.trim().toLowerCase();
}

export function parseBody(event: RestApiEvent): Record<string, unknown> {
  assertBodyWithin(event, DEFAULT_BODY_BYTE_LIMIT);
  if (!event.body) return {};
  if (contentType(event) !== "application/json") {
    throw new IdentityError("invalid_request", "Content-Type must be application/json.", {
      exposeDescription: true,
      status: 415,
    });
  }
  const decoded = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  const value = JSON.parse(decoded) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new IdentityError("invalid_request", "Expected a JSON object.");
  }
  return value as Record<string, unknown>;
}

/** `maxBytes` bounds the body as API Gateway delivers it, before any base64 decoding. */
export function parseForm(event: RestApiEvent, maxBytes = DEFAULT_BODY_BYTE_LIMIT) {
  assertBodyWithin(event, maxBytes);
  if (contentType(event) !== "application/x-www-form-urlencoded") {
    throw new IdentityError("invalid_request", "Expected form-encoded OAuth parameters.");
  }
  const decoded = event.isBase64Encoded
    ? Buffer.from(event.body ?? "", "base64").toString("utf8")
    : (event.body ?? "");
  const parameters = new URLSearchParams(decoded);
  const seen = new Set<string>();
  for (const name of parameters.keys()) {
    if (seen.has(name)) {
      throw new IdentityError("invalid_request", "OAuth parameters must not be repeated.");
    }
    seen.add(name);
  }
  return Object.fromEntries(parameters);
}
