import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
  SelfHostedWebToolError,
  encoded,
  nonEmpty,
  type FirecrawlJobKind,
  type SelfHostedWebToolsConfig,
} from "./config.ts";

interface FirecrawlJobTicketPayload {
  readonly id: string;
  readonly kind: FirecrawlJobKind;
  readonly scope: string;
  readonly version: 1;
}

interface FirecrawlCursorPayload extends FirecrawlJobTicketPayload {
  readonly query: Readonly<Record<string, string>>;
}

export function jobTicketConfig(config: SelfHostedWebToolsConfig) {
  const scope = nonEmpty(config.scopeId);
  const secret = config.jobTicketSecret;
  if (!scope || scope.length > 256) {
    throw new SelfHostedWebToolError(
      "scopeId is required for asynchronous Firecrawl job operations.",
    );
  }
  if (!secret || Buffer.byteLength(secret, "utf8") < 32) {
    throw new SelfHostedWebToolError(
      "jobTicketSecret must contain at least 32 bytes for asynchronous Firecrawl job operations.",
    );
  }
  return { scope, secret };
}

function tokenKey(secret: string) {
  return createHash("sha256").update(secret, "utf8").digest();
}

function encryptToken(prefix: "fcc1" | "fcj1", payload: unknown, secret: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", tokenKey(secret), iv);
  cipher.setAAD(Buffer.from(prefix, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return [
    prefix,
    iv.toString("base64url"),
    ciphertext.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
  ].join(".");
}

function decryptToken<T>(value: unknown, prefix: "fcc1" | "fcj1", secret: string): T {
  if (typeof value !== "string" || value.length > 4_096) {
    throw new SelfHostedWebToolError(
      `Invalid Firecrawl ${prefix === "fcj1" ? "job" : "cursor"} token.`,
    );
  }
  const [actualPrefix, encodedIv, encodedCiphertext, encodedTag, extra] = value.split(".");
  if (
    actualPrefix !== prefix ||
    !encodedIv ||
    !encodedCiphertext ||
    !encodedTag ||
    extra !== undefined
  ) {
    throw new SelfHostedWebToolError(
      `Invalid Firecrawl ${prefix === "fcj1" ? "job" : "cursor"} token.`,
    );
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      tokenKey(secret),
      Buffer.from(encodedIv, "base64url"),
    );
    decipher.setAAD(Buffer.from(prefix, "utf8"));
    decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(encodedCiphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(plaintext) as T;
  } catch {
    throw new SelfHostedWebToolError(
      `Invalid Firecrawl ${prefix === "fcj1" ? "job" : "cursor"} token.`,
    );
  }
}

export function createSelfHostedWebToolJobTicket(options: {
  readonly config: SelfHostedWebToolsConfig;
  readonly jobKind: FirecrawlJobKind;
  readonly upstreamId: string;
}) {
  const upstreamId = decodeURIComponent(encoded(options.upstreamId, "upstreamId"));
  const { scope, secret } = jobTicketConfig(options.config);
  return encryptToken(
    "fcj1",
    {
      id: upstreamId,
      kind: options.jobKind,
      scope,
      version: 1,
    } satisfies FirecrawlJobTicketPayload,
    secret,
  );
}

export function upstreamIdFromJobTicket(
  value: unknown,
  expectedKind: FirecrawlJobKind,
  config: SelfHostedWebToolsConfig,
) {
  const { scope, secret } = jobTicketConfig(config);
  const payload = decryptToken<FirecrawlJobTicketPayload>(value, "fcj1", secret);
  if (payload.version !== 1 || payload.kind !== expectedKind || payload.scope !== scope) {
    throw new SelfHostedWebToolError("Firecrawl job ticket is not valid for this scope.");
  }
  return decodeURIComponent(encoded(payload.id, "job ticket id"));
}

function createPaginationCursor(options: {
  readonly config: SelfHostedWebToolsConfig;
  readonly jobKind: FirecrawlJobKind;
  readonly query: Readonly<Record<string, string>>;
  readonly upstreamId: string;
}) {
  const { scope, secret } = jobTicketConfig(options.config);
  return encryptToken(
    "fcc1",
    {
      id: options.upstreamId,
      kind: options.jobKind,
      query: options.query,
      scope,
      version: 1,
    } satisfies FirecrawlCursorPayload,
    secret,
  );
}

export function queryFromPaginationCursor(options: {
  readonly config: SelfHostedWebToolsConfig;
  readonly cursor: unknown;
  readonly jobKind: FirecrawlJobKind;
  readonly upstreamId: string;
}) {
  const { scope, secret } = jobTicketConfig(options.config);
  const payload = decryptToken<FirecrawlCursorPayload>(options.cursor, "fcc1", secret);
  if (
    payload.version !== 1 ||
    payload.kind !== options.jobKind ||
    payload.scope !== scope ||
    payload.id !== options.upstreamId
  ) {
    throw new SelfHostedWebToolError("Firecrawl pagination cursor is not valid for this job.");
  }
  return payload.query;
}

function paginationQuery(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new SelfHostedWebToolError("Firecrawl returned an invalid pagination URL.", 502);
  }
  const query: Record<string, string> = {};
  for (const key of ["limit", "skip"] as const) {
    const raw = parsed.searchParams.get(key);
    if (raw === null) continue;
    const number = Number(raw);
    if (!Number.isSafeInteger(number) || number < 0) {
      throw new SelfHostedWebToolError("Firecrawl returned an invalid pagination cursor.", 502);
    }
    query[key] = raw;
  }
  if (!query.skip) {
    throw new SelfHostedWebToolError("Firecrawl pagination URL did not include a cursor.", 502);
  }
  return query;
}

export function replaceUpstreamJobId(value: unknown, upstreamId: string, ticket: string): unknown {
  if (typeof value === "string") return value.replaceAll(upstreamId, ticket);
  if (Array.isArray(value)) {
    return value.map((entry) => replaceUpstreamJobId(entry, upstreamId, ticket));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        replaceUpstreamJobId(entry, upstreamId, ticket),
      ]),
    );
  }
  return value;
}

const FIRECRAWL_INTERNAL_ID_FIELDS = new Set([
  "batchScrapeId",
  "crawlId",
  "jobId",
  "scrapeId",
  "scrapeIds",
]);

export function sanitizeFirecrawlResult(
  value: unknown,
  options: { readonly preserveRootId?: boolean } = {},
  depth = 0,
  redactIds = false,
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeFirecrawlResult(entry, options, depth, redactIds));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => {
      if (FIRECRAWL_INTERNAL_ID_FIELDS.has(key)) return [];
      if (key === "id" && (redactIds || (depth === 0 && !options.preserveRootId))) {
        return [];
      }
      return [
        [key, sanitizeFirecrawlResult(entry, options, depth + 1, redactIds || key === "errors")],
      ];
    }),
  );
}

export function protectStartedJobResult(
  value: unknown,
  jobKind: FirecrawlJobKind,
  config: SelfHostedWebToolsConfig,
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SelfHostedWebToolError("Firecrawl job start returned an invalid response.", 502);
  }
  const upstreamId = nonEmpty(
    typeof (value as Record<string, unknown>).id === "string"
      ? ((value as Record<string, unknown>).id as string)
      : undefined,
  );
  if (!upstreamId) {
    throw new SelfHostedWebToolError("Firecrawl job start did not return a job ID.", 502);
  }
  const ticket = createSelfHostedWebToolJobTicket({
    config,
    jobKind,
    upstreamId,
  });
  const protectedValue = sanitizeFirecrawlResult(replaceUpstreamJobId(value, upstreamId, ticket), {
    preserveRootId: true,
  }) as Record<string, unknown>;
  if (typeof protectedValue.url === "string" && protectedValue.url.includes(ticket)) {
    const { url: _url, ...result } = protectedValue;
    return result;
  }
  return protectedValue;
}

export function protectJobResult(options: {
  readonly config: SelfHostedWebToolsConfig;
  readonly jobKind: FirecrawlJobKind;
  readonly ticket: string;
  readonly upstreamId: string;
  readonly value: unknown;
}) {
  const protectedValue = sanitizeFirecrawlResult(
    replaceUpstreamJobId(options.value, options.upstreamId, options.ticket),
  );
  if (!protectedValue || typeof protectedValue !== "object" || Array.isArray(protectedValue)) {
    return protectedValue;
  }
  const record = protectedValue as Record<string, unknown>;
  if (typeof record.next !== "string") return { ...record, id: options.ticket };
  const { next: _next, ...rest } = record;
  return {
    ...rest,
    id: options.ticket,
    nextCursor: createPaginationCursor({
      config: options.config,
      jobKind: options.jobKind,
      query: paginationQuery(record.next),
      upstreamId: options.upstreamId,
    }),
  };
}
