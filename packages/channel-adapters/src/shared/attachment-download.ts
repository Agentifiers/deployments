import {
  BoundedRawBodyError,
  executePinnedHttpsWithSameOriginRedirects,
  NetSecurityError,
  NetSecurityRedirectError,
  readBoundedRawBody,
  type DnsLookup,
  type ExecutePinnedHttpRequestOptions,
  type NetSecurityErrorCode,
  type ReadBoundedRawBodyErrorCode,
} from "@deployments-ai/net-security";

const FAILURE_KINDS = {
  credential_invalid: "permanent",
  host_not_allowed: "permanent",
  malformed_response: "permanent",
  redirect_refused: "permanent",
  rejected: "permanent",
  too_large: "permanent",
  provider_unavailable: "transient",
  rate_limited: "transient",
  unreachable: "transient",
} as const satisfies Record<string, "permanent" | "transient">;

export type ChannelAttachmentDownloadFailureReason = keyof typeof FAILURE_KINDS;
export type ChannelAttachmentDownloadFailureKind =
  (typeof FAILURE_KINDS)[ChannelAttachmentDownloadFailureReason];

/**
 * The message is built from the reason and status alone and no cause is kept, because provider
 * URLs can embed credentials (Telegram bot tokens).
 */
export class ChannelAttachmentDownloadError extends Error {
  readonly kind: ChannelAttachmentDownloadFailureKind;
  readonly reason: ChannelAttachmentDownloadFailureReason;
  readonly status?: number;

  constructor(
    reason: ChannelAttachmentDownloadFailureReason,
    options: { readonly status?: number } = {},
  ) {
    super(
      `Channel attachment download failed: ${reason}${
        options.status === undefined ? "" : ` (HTTP ${String(options.status)})`
      }.`,
    );
    this.name = "ChannelAttachmentDownloadError";
    this.kind = FAILURE_KINDS[reason];
    this.reason = reason;
    if (options.status !== undefined) this.status = options.status;
  }

  static forStatus(status: number) {
    const reason =
      status === 429 ? "rate_limited" : status >= 500 ? "provider_unavailable" : "rejected";
    return new ChannelAttachmentDownloadError(reason, { status });
  }
}

const NET_SECURITY_FAILURES = {
  credentials: "host_not_allowed",
  "empty-dns": "unreachable",
  "invalid-dns": "unreachable",
  "invalid-url": "host_not_allowed",
  "non-https": "host_not_allowed",
  "non-public-host": "host_not_allowed",
  "private-address": "host_not_allowed",
} as const satisfies Record<NetSecurityErrorCode, ChannelAttachmentDownloadFailureReason>;

const BODY_FAILURES = {
  body_length_mismatch: "malformed_response",
  body_too_large: "too_large",
  body_truncated: "unreachable",
  body_unavailable: "unreachable",
  invalid_content_length: "malformed_response",
} as const satisfies Record<ReadBoundedRawBodyErrorCode, ChannelAttachmentDownloadFailureReason>;

export interface ChannelAttachmentTransport {
  readonly dnsLookup?: DnsLookup;
  readonly pinnedRequest?: (args: ExecutePinnedHttpRequestOptions) => Promise<Response>;
}

export function isUrlOnOrigin(url: string, origin: string) {
  if (!URL.canParse(url)) return false;
  const parsed = new URL(url);
  return parsed.origin === origin && !parsed.username && !parsed.password;
}

export async function downloadFromOrigin(input: {
  readonly headers?: Record<string, string>;
  readonly maxBytes: number;
  readonly origin: string;
  readonly signal: AbortSignal;
  readonly transport: ChannelAttachmentTransport;
  readonly url: string;
}): Promise<Uint8Array> {
  if (!isUrlOnOrigin(input.url, input.origin)) {
    throw new ChannelAttachmentDownloadError("host_not_allowed");
  }
  let response: Response;
  try {
    ({ response } = await executePinnedHttpsWithSameOriginRedirects({
      ...(input.transport.dnsLookup ? { dnsLookup: input.transport.dnsLookup } : {}),
      ...(input.headers ? { headers: input.headers } : {}),
      method: "GET",
      ...(input.transport.pinnedRequest ? { pinnedRequest: input.transport.pinnedRequest } : {}),
      signal: input.signal,
      url: input.url,
      verifiedOrigin: input.origin,
    }));
  } catch (cause) {
    throw new ChannelAttachmentDownloadError(
      cause instanceof NetSecurityRedirectError
        ? "redirect_refused"
        : cause instanceof NetSecurityError
          ? NET_SECURITY_FAILURES[cause.code]
          : "unreachable",
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw ChannelAttachmentDownloadError.forStatus(response.status);
  }
  try {
    return await readBoundedRawBody(response.body, {
      contentLengthHeader: response.headers.get("content-length"),
      maxBytes: input.maxBytes,
    });
  } catch (cause) {
    await response.body?.cancel().catch(() => undefined);
    throw new ChannelAttachmentDownloadError(
      cause instanceof BoundedRawBodyError ? BODY_FAILURES[cause.code] : "unreachable",
    );
  }
}
