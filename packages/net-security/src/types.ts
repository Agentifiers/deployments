export type IpFamily = 4 | 6;

export interface ResolvedAddress {
  readonly address: string;
  readonly family: IpFamily;
}

export type DnsLookup = (
  hostname: string,
) => Promise<readonly ResolvedAddress[]> | readonly ResolvedAddress[];

export interface NormalizePublicHttpsUrlOptions {
  /**
   * When true, allow `http(s)://localhost` and `*.localhost` for explicit local
   * development / test mode only. Private and link-local IPs remain blocked.
   */
  readonly allowLocalTargets?: boolean;
}

export type NetSecurityErrorCode =
  | "credentials"
  | "empty-dns"
  | "invalid-dns"
  | "invalid-url"
  | "non-https"
  | "non-public-host"
  | "private-address";

export class NetSecurityError extends Error {
  readonly code: NetSecurityErrorCode;

  constructor(code: NetSecurityErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NetSecurityError";
    this.code = code;
  }
}

export interface ResolvePublicHttpsTargetOptions {
  readonly allowLocalTargets?: boolean;
  readonly dnsLookup?: DnsLookup;
}

export interface ResolvedPublicHttpsTarget {
  readonly addresses: readonly ResolvedAddress[];
  readonly localTarget: boolean;
  readonly url: string;
}

export interface PinnedLookupOptions {
  readonly emptyMessage?: string;
}

export interface ExecutePinnedHttpRequestOptions {
  readonly addresses: readonly ResolvedAddress[];
  /**
   * When true, allow cleartext `http:` only for `localhost` / `*.localhost`.
   * Defaults to false (HTTPS-only). Used only for explicit local/test mode.
   * Public and non-local hosts always require HTTPS regardless of this flag.
   */
  readonly allowHttp?: boolean;
  readonly body?: string | Uint8Array;
  readonly emptyLookupMessage?: string;
  readonly headers?: Record<string, string>;
  readonly method?: string;
  readonly signal: AbortSignal;
  readonly url: string | URL;
}

export type NetSecurityRedirectErrorCode =
  | "redirect-cross-origin"
  | "redirect-invalid"
  | "redirect-limit";

export class NetSecurityRedirectError extends Error {
  readonly code: NetSecurityRedirectErrorCode;

  constructor(code: NetSecurityRedirectErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NetSecurityRedirectError";
    this.code = code;
  }
}

export interface ExecutePinnedHttpsWithSameOriginRedirectsOptions {
  /**
   * Immutable verified origin (scheme + host + non-default port). Every hop
   * Location must resolve to this exact origin after normalization.
   */
  readonly verifiedOrigin: string;
  /** Initial request URL — must be under verifiedOrigin (path/query allowed). */
  readonly url: string | URL;
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string | Uint8Array;
  readonly signal: AbortSignal;
  readonly dnsLookup?: DnsLookup;
  readonly maxRedirects?: number;
  /**
   * Injectable pinned transport (tests). Defaults to {@link executePinnedHttpRequest}.
   */
  readonly pinnedRequest?: (args: ExecutePinnedHttpRequestOptions) => Promise<Response>;
}

export interface ExecutePinnedHttpsWithSameOriginRedirectsResult {
  readonly response: Response;
  readonly finalUrl: string;
  readonly hopCount: number;
  readonly addresses: readonly ResolvedAddress[];
}

export const DEFAULT_PINNED_HTTPS_MAX_REDIRECTS = 5;
