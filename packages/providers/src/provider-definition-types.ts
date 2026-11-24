/**
 * Platform provider-definition primitives.
 *
 * Code owns the canonical registry shape: route, auth field schema, hosts, scopes,
 * tools, and lifecycle status. Definitions describe credential fields only and never
 * carry secret values.
 */

import type {
  VendorMcpServerDefinition,
  VendorMcpServerDefinitionInput,
} from "./vendor-mcp-types.ts";

export const PROVIDER_ROUTES = [
  "platform_api_credential",
  "platform_oauth",
  "mcp_gateway",
  "vendor_mcp",
  "platform_webhook",
  "sandbox_tool",
  "manual_browser",
  "unsupported",
] as const;

export type ProviderRoute = (typeof PROVIDER_ROUTES)[number];

export const TOKEN_BEARING_PROVIDER_ROUTES = [
  "platform_api_credential",
  "platform_oauth",
  "mcp_gateway",
  "vendor_mcp",
] as const satisfies readonly ProviderRoute[];

export type TokenBearingProviderRoute = (typeof TOKEN_BEARING_PROVIDER_ROUTES)[number];

export const NON_TOKEN_PROVIDER_ROUTES = [
  "platform_webhook",
  "sandbox_tool",
  "manual_browser",
  "unsupported",
] as const satisfies readonly ProviderRoute[];

export type NonTokenProviderRoute = (typeof NON_TOKEN_PROVIDER_ROUTES)[number];

export const PROVIDER_CREDENTIAL_KINDS = [
  "api_key",
  "basic",
  "service_account",
  "json",
  "oauth_client_credentials",
  "oauth",
  "none",
] as const;

export type ProviderCredentialKind = (typeof PROVIDER_CREDENTIAL_KINDS)[number];

export const PROVIDER_DEFINITION_STATUSES = [
  "planned",
  "configured",
  "verified",
  "unsupported",
] as const;

export type ProviderDefinitionStatus = (typeof PROVIDER_DEFINITION_STATUSES)[number];

export const PROVIDER_AUTH_FIELD_DISPLAY_FORMATS = ["last4", "suffix", "masked", "none"] as const;

export type ProviderAuthFieldDisplayFormat = (typeof PROVIDER_AUTH_FIELD_DISPLAY_FORMATS)[number];

/** Default is string; json allows composite object/array credential fields. */
export const PROVIDER_AUTH_FIELD_VALUE_TYPES = ["string", "json"] as const;

export type ProviderAuthFieldValueType = (typeof PROVIDER_AUTH_FIELD_VALUE_TYPES)[number];

export const PROVIDER_VERIFICATION_METHODS = [
  "api_probe",
  "oauth_scopes",
  "webhook_challenge",
  "manual",
  "none",
  "mcp_discovery",
] as const;

export type ProviderVerificationMethod = (typeof PROVIDER_VERIFICATION_METHODS)[number];

export const PROVIDER_PROBE_HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

export type ProviderProbeHttpMethod = (typeof PROVIDER_PROBE_HTTP_METHODS)[number];

export const PROVIDER_HOST_POLICY_MODES = ["allowlist", "verified_origin"] as const;

export type ProviderHostPolicyMode = (typeof PROVIDER_HOST_POLICY_MODES)[number];

export const PROVIDER_TOOL_EFFECTS = ["read", "write", "execute"] as const;

export type ProviderToolEffect = (typeof PROVIDER_TOOL_EFFECTS)[number];

export const PROVIDER_INPUT_SCHEMA_TYPES = [
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
] as const;

export const PROVIDER_RETRYABLE_STATUS_CODES = [408, 425, 429, 500, 502, 503, 504] as const;

export type ProviderInputSchemaPrimitive =
  | "array"
  | "boolean"
  | "integer"
  | "null"
  | "number"
  | "object"
  | "string";

export interface ProviderInputSchemaPropertyInput {
  readonly additionalProperties?: boolean;
  readonly description?: string;
  readonly enum?: readonly (boolean | number | null | string)[];
  readonly format?: string;
  readonly items?: ProviderInputSchemaPropertyInput;
  readonly maximum?: number;
  readonly minimum?: number;
  readonly minItems?: number;
  readonly minLength?: number;
  readonly pattern?: string;
  readonly properties?: Readonly<Record<string, ProviderInputSchemaPropertyInput>>;
  readonly required?: readonly string[];
  readonly type?: ProviderInputSchemaPrimitive | readonly ProviderInputSchemaPrimitive[];
}

export interface ProviderInputSchemaProperty extends ProviderInputSchemaPropertyInput {
  readonly additionalProperties?: boolean;
  readonly items?: ProviderInputSchemaProperty;
  readonly properties?: Readonly<Record<string, ProviderInputSchemaProperty>>;
  readonly required?: readonly string[];
  readonly type?: ProviderInputSchemaPrimitive | readonly ProviderInputSchemaPrimitive[];
}

/** Deliberately small JSON-Schema subset shared by provider connection/tool contracts. */
export interface ProviderInputSchemaInput {
  readonly additionalProperties?: boolean;
  readonly description?: string;
  readonly properties?: Readonly<Record<string, ProviderInputSchemaPropertyInput>>;
  readonly required?: readonly string[];
  readonly type?: "object";
}

export interface ProviderInputSchema {
  readonly additionalProperties: boolean;
  readonly description?: string;
  readonly properties: Readonly<Record<string, ProviderInputSchemaProperty>>;
  readonly required: readonly string[];
  readonly type: "object";
}

export interface ProviderHostPolicyInput {
  readonly hosts?: readonly string[];
  readonly mode?: string;
  readonly requireHttps?: boolean;
}

export interface ProviderHostPolicy {
  readonly hosts: readonly string[];
  readonly mode: ProviderHostPolicyMode;
  readonly requireHttps: true;
}

export interface ProviderVerificationProbeInput {
  readonly body?: string;
  readonly expectedStatusCodes?: readonly number[];
  readonly headers?: Readonly<Record<string, string>>;
  readonly host?: string;
  readonly identityIdPath?: string;
  readonly method?: string;
  readonly path: string;
  readonly pathFieldKeys?: readonly string[];
  readonly requiredScopes?: readonly string[];
  readonly timeoutMs?: number;
}

export interface ProviderVerificationProbe {
  readonly body?: string;
  readonly expectedStatusCodes: readonly number[];
  readonly headers?: Readonly<Record<string, string>>;
  readonly host?: string;
  readonly identityIdPath?: string;
  readonly method: ProviderProbeHttpMethod;
  readonly path: string;
  readonly pathFieldKeys: readonly string[];
  readonly requiredScopes: readonly string[];
  readonly timeoutMs: number;
}

export interface ProviderRateLimitPolicyInput {
  readonly maxConcurrentRequests?: number;
  readonly maxRequestsPerWindow: number;
  readonly retryAfterHeader?: string;
  readonly windowMs: number;
}

export interface ProviderRateLimitPolicy {
  readonly maxConcurrentRequests?: number;
  readonly maxRequestsPerWindow: number;
  readonly retryAfterHeader: string;
  readonly windowMs: number;
}

export interface ProviderRetryPolicyInput {
  readonly baseDelayMs?: number;
  readonly maxAttempts?: number;
  readonly maxDelayMs?: number;
  readonly respectRetryAfter?: boolean;
  readonly retryableStatusCodes?: readonly number[];
}

export interface ProviderRetryPolicy {
  readonly baseDelayMs: number;
  readonly maxAttempts: number;
  readonly maxDelayMs: number;
  readonly respectRetryAfter: boolean;
  readonly retryableStatusCodes: readonly number[];
}

export interface ProviderResourceMetadataInput {
  readonly authorizationRequired?: boolean;
  readonly resourceTypes?: readonly string[];
  readonly selectorKeys?: readonly string[];
}

export interface ProviderResourceMetadata {
  readonly authorizationRequired: boolean;
  readonly resourceTypes: readonly string[];
  readonly selectorKeys: readonly string[];
}

export interface ProviderEffectMetadataInput {
  readonly allowedEffects?: readonly string[];
  readonly defaultWritePolicy?: string;
  readonly outboundMutation?: boolean;
}

export interface ProviderEffectMetadata {
  readonly allowedEffects: readonly ProviderToolEffect[];
  readonly defaultWritePolicy: "allow" | "deny" | "require_approval";
  readonly outboundMutation: boolean;
}

export interface ProviderAuditMetadataInput {
  readonly dataClasses?: readonly string[];
  readonly redactedFieldKeys?: readonly string[];
  readonly retentionClass?: string;
}

export interface ProviderAuditMetadata {
  readonly dataClasses: readonly string[];
  readonly redactedFieldKeys: readonly string[];
  readonly retentionClass?: string;
}

export interface ProviderConformanceMetadataInput {
  readonly requiredChecks?: readonly string[];
  readonly schemaVersion?: number;
  readonly secretRedactionRequired?: boolean;
}

export interface ProviderConformanceMetadata {
  readonly requiredChecks: readonly string[];
  readonly schemaVersion: number;
  readonly secretRedactionRequired: boolean;
}

export const PROVIDER_KEY_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
export const AUTH_FIELD_KEY_PATTERN = /^[a-z][a-zA-Z0-9_]{0,63}$/;
export const OAUTH_PROVIDER_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
export const API_HOST_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;

export const MAX_PROVIDER_KEY_LENGTH = 64;
export const MAX_DISPLAY_NAME_LENGTH = 120;
export const MAX_CATEGORY_LENGTH = 64;
export const MAX_ALIAS_COUNT = 32;
export const MAX_AUTH_FIELD_COUNT = 32;
export const MAX_API_HOST_COUNT = 64;
export const MAX_SCOPE_COUNT = 128;
export const MAX_TOOL_COUNT = 256;
export const MAX_HOST_LENGTH = 253;
export const MAX_SCHEMA_DEPTH = 8;
export const DEFAULT_RETRY_AFTER_HEADER = "retry-after";
export const DEFAULT_RETRYABLE_STATUS_CODES = [...PROVIDER_RETRYABLE_STATUS_CODES];

export interface ProviderAuthFieldDefinitionInput {
  readonly defaultValue?: string;
  readonly description?: string;
  readonly displayFormat?: string;
  readonly displayName: string;
  readonly key: string;
  readonly required?: boolean;
  readonly sensitive: boolean;
  /** Defaults to `string`. Use `json` for composite service-account style fields. */
  readonly valueType?: string;
}

export interface ProviderAuthFieldDefinition {
  readonly defaultValue?: string;
  readonly description?: string;
  readonly displayFormat: ProviderAuthFieldDisplayFormat;
  readonly displayName: string;
  readonly key: string;
  readonly required: boolean;
  readonly sensitive: boolean;
  readonly valueType: ProviderAuthFieldValueType;
}

export interface ProviderAuthDefinitionInput {
  readonly fields?: readonly ProviderAuthFieldDefinitionInput[];
  readonly kind: string;
  readonly requestFieldKeys?: readonly string[];
  readonly tokenExchange?: ProviderClientCredentialsTokenExchangeInput;
  readonly transport?: ProviderAuthTransportInput;
}

export interface ProviderAuthDefinition {
  readonly fields: readonly ProviderAuthFieldDefinition[];
  readonly kind: ProviderCredentialKind;
  readonly requestFieldKeys: readonly string[];
  readonly tokenExchange?: ProviderClientCredentialsTokenExchange;
  readonly transport?: ProviderAuthTransport;
}

export const PROVIDER_TOKEN_EXCHANGE_TYPES = ["oauth_client_credentials"] as const;
export type ProviderTokenExchangeType = (typeof PROVIDER_TOKEN_EXCHANGE_TYPES)[number];

export const PROVIDER_TOKEN_EXCHANGE_BODY_FORMATS = ["form", "json"] as const;
export type ProviderTokenExchangeBodyFormat = (typeof PROVIDER_TOKEN_EXCHANGE_BODY_FORMATS)[number];

export const PROVIDER_TOKEN_EXCHANGE_CLIENT_AUTHENTICATIONS = ["body", "basic"] as const;
export type ProviderTokenExchangeClientAuthentication =
  (typeof PROVIDER_TOKEN_EXCHANGE_CLIENT_AUTHENTICATIONS)[number];

export interface ProviderClientCredentialsTokenParameterInput {
  readonly fieldKey: string;
  readonly parameterName: string;
}

export type ProviderClientCredentialsTokenParameter = Readonly<{
  readonly fieldKey: string;
  readonly parameterName: string;
}>;

export interface ProviderClientCredentialsTokenExchangeInput {
  readonly bodyFormat?: string;
  readonly clientAuthentication?: string;
  readonly clientIdFieldKey: string;
  readonly clientIdParameterName?: string;
  readonly clientSecretFieldKey: string;
  readonly clientSecretParameterName?: string;
  readonly endpoint: string;
  readonly grantTypeParameterName?: string;
  readonly parameters?: readonly ProviderClientCredentialsTokenParameterInput[];
  readonly type: string;
}

export type ProviderClientCredentialsTokenExchange = Readonly<{
  readonly bodyFormat: ProviderTokenExchangeBodyFormat;
  readonly clientAuthentication: ProviderTokenExchangeClientAuthentication;
  readonly clientIdFieldKey: string;
  readonly clientIdParameterName: string;
  readonly clientSecretFieldKey: string;
  readonly clientSecretParameterName: string;
  readonly endpoint: string;
  readonly grantTypeParameterName: string;
  readonly parameters: readonly ProviderClientCredentialsTokenParameter[];
  readonly type: "oauth_client_credentials";
}>;

export const PROVIDER_AUTH_TRANSPORT_TYPES = [
  "basic",
  "bearer",
  "header",
  "headers",
  "query",
] as const;
export type ProviderAuthTransportType = (typeof PROVIDER_AUTH_TRANSPORT_TYPES)[number];

export interface ProviderAuthHeaderTransportInput {
  readonly fieldKey?: string;
  readonly headerName?: string;
  readonly prefix?: string;
}

export type ProviderAuthHeaderTransport = Readonly<{
  readonly fieldKey: string;
  readonly headerName: string;
  readonly prefix: string;
}>;

export interface ProviderAuthTransportInput {
  readonly fieldKey?: string;
  readonly headerFields?: readonly ProviderAuthHeaderTransportInput[];
  readonly headerName?: string;
  readonly parameterName?: string;
  readonly passwordFieldKey?: string;
  readonly prefix?: string;
  readonly type: string;
  readonly usernameFieldKey?: string;
}

export type ProviderAuthTransport = Readonly<{
  readonly fieldKey?: string;
  readonly headerFields?: readonly ProviderAuthHeaderTransport[];
  readonly headerName?: string;
  readonly parameterName?: string;
  readonly passwordFieldKey?: string;
  readonly prefix: string;
  readonly type: ProviderAuthTransportType;
  readonly usernameFieldKey?: string;
}>;

export interface ProviderOriginPolicyInput {
  readonly fieldKey: string;
  readonly hostMatch?: "exact" | "suffix";
  readonly requireHttps?: boolean;
}

export interface ProviderOriginPolicy {
  readonly fieldKey: string;
  readonly hostMatch: "exact" | "suffix";
  readonly immutableAfterVerification: true;
  readonly requireHttps: true;
}

export interface ProviderVerificationDefinitionInput {
  readonly description?: string;
  readonly method?: string;
  readonly probe?: ProviderVerificationProbeInput;
  readonly required: boolean;
}

export interface ProviderVerificationDefinition {
  readonly description?: string;
  readonly method: ProviderVerificationMethod;
  readonly probe?: ProviderVerificationProbe;
  readonly required: boolean;
}

export interface ProviderDefinitionInput {
  readonly aliases?: readonly string[];
  readonly apiHosts?: readonly string[];
  readonly authorizationScopes?: readonly string[];
  readonly authorizationScopeCapabilities?: Readonly<Record<string, readonly string[]>>;
  readonly authorizationScopeMode?: "manifest" | "oauth_request";
  readonly auth: ProviderAuthDefinitionInput;
  readonly category: string;
  readonly defaultScopes?: readonly string[];
  readonly displayName: string;
  readonly effectMetadata?: ProviderEffectMetadataInput;
  readonly auditMetadata?: ProviderAuditMetadataInput;
  readonly conformanceMetadata?: ProviderConformanceMetadataInput;
  readonly hostPolicy?: ProviderHostPolicyInput;
  readonly inputSchema?: ProviderInputSchemaInput;
  readonly key: string;
  readonly originPolicy?: ProviderOriginPolicyInput | undefined;
  /** Required for and only valid on route `vendor_mcp`. */
  readonly mcpServer?: VendorMcpServerDefinitionInput;
  readonly rateLimitPolicy?: ProviderRateLimitPolicyInput;
  readonly resourceMetadata?: ProviderResourceMetadataInput;
  readonly retryPolicy?: ProviderRetryPolicyInput;
  readonly route: string;
  readonly status: string;
  readonly supportsMultipleAccounts?: boolean;
  readonly tools?: readonly string[];
  readonly verification: ProviderVerificationDefinitionInput;
  readonly oauthProviderKey?: string;
  readonly oauthResources?: readonly string[];
}

export interface ProviderDefinition {
  readonly aliases: readonly string[];
  readonly apiHosts: readonly string[];
  readonly authorizationScopes: readonly string[];
  readonly authorizationScopeCapabilities: Readonly<Record<string, readonly string[]>>;
  readonly authorizationScopeMode: "manifest" | "oauth_request";
  readonly auth: ProviderAuthDefinition;
  readonly category: string;
  readonly defaultScopes: readonly string[];
  readonly displayName: string;
  readonly effectMetadata?: ProviderEffectMetadata;
  readonly auditMetadata?: ProviderAuditMetadata;
  readonly conformanceMetadata?: ProviderConformanceMetadata;
  readonly hostPolicy: ProviderHostPolicy;
  readonly inputSchema?: ProviderInputSchema;
  readonly key: string;
  readonly originPolicy?: ProviderOriginPolicy;
  readonly mcpServer?: VendorMcpServerDefinition;
  readonly rateLimitPolicy?: ProviderRateLimitPolicy;
  readonly resourceMetadata?: ProviderResourceMetadata;
  readonly retryPolicy?: ProviderRetryPolicy;
  readonly route: ProviderRoute;
  readonly status: ProviderDefinitionStatus;
  readonly supportsMultipleAccounts: boolean;
  readonly tools: readonly string[];
  readonly verification: ProviderVerificationDefinition;
  readonly oauthProviderKey?: string;
  readonly oauthResources: readonly string[];
}

export interface ProviderDefinitionRegistry {
  readonly definitions: readonly ProviderDefinition[];
  getByAlias(alias: string): ProviderDefinition | undefined;
  getByKey(key: string): ProviderDefinition | undefined;
  /** Returns one definition when an OAuth app key maps to exactly one capability. */
  getByOAuthProviderKey(key: string): ProviderDefinition | undefined;
  list(): readonly ProviderDefinition[];
  /**
   * All definitions that share one platform OAuth app configuration, sorted by
   * canonical provider key.
   */
  listByOAuthProviderKey(key: string): readonly ProviderDefinition[];
  /**
   * Exact match by canonical key, alias, then a unique OAuth provider key.
   */
  resolve(identifier: string): ProviderDefinition | undefined;
}
