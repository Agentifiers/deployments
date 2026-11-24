import type { ToolEffect, ToolPolicyAction } from "../types.ts";

export type ProviderNativeSchemaPrimitive =
  | "array"
  | "boolean"
  | "integer"
  | "null"
  | "number"
  | "object"
  | "string";

/** Reserved audit envelope accepted by provider writes and removed before transport. */
export const PROVIDER_NATIVE_ARTIFACT_HANDOFF_INPUT_KEY = "_artifactHandoff" as const;

export interface ProviderNativeInputSchemaProperty {
  readonly additionalProperties?: boolean;
  readonly description?: string;
  readonly enum?: readonly (boolean | number | null | string)[];
  readonly format?: string;
  readonly items?: ProviderNativeInputSchemaProperty;
  readonly maximum?: number;
  readonly minimum?: number;
  readonly minItems?: number;
  readonly minLength?: number;
  readonly pattern?: string;
  readonly properties?: Readonly<Record<string, ProviderNativeInputSchemaProperty>>;
  readonly required?: readonly string[];
  readonly type?: ProviderNativeSchemaPrimitive | readonly ProviderNativeSchemaPrimitive[];
}

export interface ProviderNativeInputSchema {
  readonly additionalProperties?: boolean;
  readonly description?: string;
  readonly properties?: Readonly<Record<string, ProviderNativeInputSchemaProperty>>;
  readonly oneOf?: readonly { readonly required?: readonly string[] }[];
  readonly required?: readonly string[];
  readonly type: "object";
}

export type ProviderNativeHostPolicy =
  | {
      readonly hosts: readonly string[];
      readonly mode: "allowlist";
      readonly requireHttps: true;
    }
  | {
      readonly hosts?: readonly string[];
      readonly mode: "verified_origin";
      readonly requireHttps: true;
    };

export interface ProviderNativeVerificationProbe {
  readonly expectedStatusCodes?: readonly number[];
  readonly host?: string;
  readonly method?: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
  readonly path: string;
  readonly requiredScopes?: readonly string[];
  readonly timeoutMs?: number;
}

export interface ProviderNativeRateLimitPolicy {
  readonly maxConcurrentRequests?: number;
  readonly maxRequestsPerWindow: number;
  readonly retryAfterHeader?: string;
  readonly windowMs: number;
}

export interface ProviderNativeRetryPolicy {
  readonly baseDelayMs: number;
  readonly maxAttempts: number;
  readonly maxDelayMs: number;
  readonly respectRetryAfter?: boolean;
  readonly retryableStatusCodes: readonly number[];
}

export interface ProviderNativeResourceMetadata {
  readonly authorizationRequired?: boolean;
  readonly resourceTypes?: readonly string[];
  readonly selectorKeys?: readonly string[];
}

export interface ProviderNativeEffectMetadata {
  readonly allowedEffects?: readonly ToolEffect[];
  readonly outboundMutation?: boolean;
  readonly writeRequiresApproval?: boolean;
}

export interface ProviderNativeRetryConformanceCase {
  readonly attempt: number;
  readonly expectedDelayMs?: number;
  readonly expectedRetry: boolean;
  readonly responseHeaders?: Readonly<Record<string, string>>;
  readonly status: number;
}

export interface ProviderNativeConformanceMetadata {
  readonly expectedHost?: string;
  readonly requiredChecks?: readonly string[];
  readonly retryCases?: readonly ProviderNativeRetryConformanceCase[];
  readonly sampleExternalAccountId?: string;
  readonly sampleInput?: Readonly<Record<string, unknown>>;
  readonly secretValues?: readonly string[];
}

export const PROVIDER_API_HOST_SUFFIXES: Record<string, readonly string[]> = {
  bitbucket: ["api.bitbucket.org"],
  google: ["googleapis.com"],
  google_ads: ["googleads.googleapis.com"],
  google_search_console: ["searchconsole.googleapis.com"],
  "microsoft-dynamics-365": ["dynamics.com", "microsoft.com"],
  "microsoft-outlook": ["graph.microsoft.com"],
  "microsoft-sharepoint": ["graph.microsoft.com"],
  microsoft_teams: ["graph.microsoft.com"],
  netsuite: ["suitetalk.api.netsuite.com"],
  onedrive: ["graph.microsoft.com"],
  quickbooks: ["quickbooks.api.intuit.com", "sandbox-quickbooks.api.intuit.com"],
  shopify: ["myshopify.com"],
  snowflake: ["snowflakecomputing.com"],
  zendesk: ["zendesk.com"],
  "zendesk-sell": ["api.getbase.com", "api.sell.zendesk.com"],
};

export const PROVIDER_NATIVE_ORIGIN_PROVIDERS = new Set(["wordpress"]);

export function providerNativeHostPolicy(provider: string): ProviderNativeHostPolicy {
  const normalizedProvider = provider.trim().toLowerCase();
  if (PROVIDER_NATIVE_ORIGIN_PROVIDERS.has(normalizedProvider)) {
    return Object.freeze({ mode: "verified_origin", requireHttps: true as const });
  }
  return Object.freeze({
    hosts: Object.freeze([...(PROVIDER_API_HOST_SUFFIXES[normalizedProvider] ?? [])]),
    mode: "allowlist",
    requireHttps: true as const,
  });
}

/** Hostnames rejected for origin-policy providers (e.g. WordPress) before request construction. */
export interface ProviderAccessToken {
  readonly externalAccountId: string;
  readonly provider: string;
  readonly token: string;
}

export interface ProviderNativeToolRequestContext {
  readonly idempotencyKey: string;
  readonly toolCallId?: string;
  readonly toolName: string;
}

export type ProviderNativeBody =
  | {
      readonly body?: ArrayBuffer | string | Uint8Array | URLSearchParams;
      readonly contentType?: string;
    }
  | undefined;

export interface ProviderNativeRetryResponseArgs {
  readonly fetch: typeof fetch;
  readonly input: Record<string, unknown>;
  readonly request: ProviderNativeToolRequestContext;
  readonly requestInit: RequestInit;
  readonly requestUrl: string;
  readonly response: Response;
  readonly token: ProviderAccessToken;
}

export interface ProviderNativeHttpToolDefinition {
  readonly acceptedProviders?: readonly string[];
  /** Provider OAuth/installation permissions, distinct from runtime capability scopes. */
  readonly authorizationScopes?: readonly string[];
  /**
   * Canonical audit metadata persisted on the tool adapter definition.
   * Prefer `resourceTargets` selectors for external account/property/site/origin proof.
   */
  readonly auditMetadata?: unknown;
  readonly conformanceMetadata?: ProviderNativeConformanceMetadata;
  readonly defaultPolicyAction: ToolPolicyAction;
  readonly description: string;
  readonly effectMetadata?: ProviderNativeEffectMetadata;
  readonly effect: ToolEffect;
  /** Set when tool input names a URL the provider fetches or calls; otherwise `configured`. */
  readonly egress?: "public";
  readonly filePrefix: string;
  readonly handoffResultStatus?: "approved" | "published";
  readonly hostPolicy?: ProviderNativeHostPolicy;
  readonly inputSchema?: ProviderNativeInputSchema;
  readonly method: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
  readonly provider: string;
  readonly requiredScopes?: readonly string[];
  readonly rateLimitPolicy?: ProviderNativeRateLimitPolicy;
  readonly resourceMetadata?: ProviderNativeResourceMetadata;
  readonly retryPolicy?: ProviderNativeRetryPolicy;
  readonly toolName: string;
  readonly verificationProbe?: ProviderNativeVerificationProbe;
  requiredScopesForInput?(input: Record<string, unknown>): readonly string[];
  buildBody?(
    input: Record<string, unknown>,
    token: ProviderAccessToken,
    request: ProviderNativeToolRequestContext,
  ): ProviderNativeBody;
  buildHeaders?(
    input: Record<string, unknown>,
    token: ProviderAccessToken,
  ): Record<string, string | undefined>;
  buildUrl(
    input: Record<string, unknown>,
    token: ProviderAccessToken,
    request: ProviderNativeToolRequestContext,
  ): string;
  retryResponse?(args: ProviderNativeRetryResponseArgs): Promise<Response> | Response;
  successSummary?(
    response: Response,
    input: Record<string, unknown>,
    token: ProviderAccessToken,
  ): string;
  validateResponse?(
    response: Response,
    parsedBody: unknown,
    input: Record<string, unknown>,
    token: ProviderAccessToken,
  ): void;
}
