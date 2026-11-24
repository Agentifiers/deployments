import {
  boundedJsonProviderNativeBody,
  encodedPath,
  optionalToolObject,
  optionalToolString,
  providerApiHostAllowed,
  requireHttpsOriginBaseUrl,
  requireToolString,
  type ProviderAccessToken,
  type ProviderNativeBody,
  type ProviderNativeEffectMetadata,
  type ProviderNativeHostPolicy,
  type ProviderNativeHttpToolDefinition,
  type ProviderNativeInputSchema,
  type ProviderNativeInputSchemaProperty,
  type ProviderNativeRetryPolicy,
  type ProviderNativeToolRequestContext,
} from "../core.ts";
import { stringProperty } from "../tool-definition-builders.ts";
import { assertSafeJsonValue } from "../tool-input-guards.ts";

const ACQUISITION_RETRY_POLICY = Object.freeze({
  baseDelayMs: 250,
  maxAttempts: 3,
  maxDelayMs: 2_000,
  respectRetryAfter: true,
  retryableStatusCodes: Object.freeze([408, 425, 429, 500, 502, 503, 504]),
});

const ACQUISITION_RATE_LIMIT_POLICY = Object.freeze({
  maxConcurrentRequests: 4,
  maxRequestsPerWindow: 60,
  retryAfterHeader: "retry-after",
  windowMs: 60_000,
});

type AcquisitionUrlBuilder = (
  input: Record<string, unknown>,
  token: ProviderAccessToken,
  request: ProviderNativeToolRequestContext,
) => string;

type AcquisitionBodyBuilder = (
  input: Record<string, unknown>,
  token: ProviderAccessToken,
  request: ProviderNativeToolRequestContext,
) => ProviderNativeBody;

export function booleanProperty(): ProviderNativeInputSchemaProperty {
  return { type: "boolean" };
}

export function stringArrayProperty(): ProviderNativeInputSchemaProperty {
  return { items: stringProperty(), minItems: 1, type: "array" };
}

export function providerUrl(base: URL, pathSegments: readonly string[]): string {
  const prefix = base.pathname.replace(/\/+$/u, "");
  base.pathname = `${prefix}/${encodedPath(pathSegments.join("/"))}`;
  return base.toString();
}

export function allowlistedProviderBaseUrl(
  input: Record<string, unknown>,
  key: string,
  provider: string,
  hosts: readonly string[],
): URL {
  const raw = requireToolString(input, key);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Tool input ${key} must be a valid URL`);
  }
  if (parsed.protocol !== "https:") throw new Error(`Tool input ${key} must use https`);
  if (parsed.username || parsed.password) {
    throw new Error(`Tool input ${key} must not include credentials`);
  }
  const policy: ProviderNativeHostPolicy = {
    hosts,
    mode: "allowlist",
    requireHttps: true,
  };
  if (!providerApiHostAllowed(provider, parsed.hostname, policy)) {
    throw new Error(`Tool input ${key} host is not allowed for ${provider}`);
  }
  parsed.search = "";
  parsed.hash = "";
  parsed.pathname = parsed.pathname.replace(/\/+$/u, "") || "/";
  return parsed;
}

export function requireHttpsTarget(input: Record<string, unknown>, key: string): string {
  const raw = requireToolString(input, key);
  requireHttpsOriginBaseUrl({ [key]: raw }, [key]);
  return new URL(raw).toString();
}

export function bodyFromFields(
  input: Record<string, unknown>,
  fields: readonly string[],
  field = "body",
  overrides: Readonly<Record<string, unknown>> = {},
): ProviderNativeBody {
  const explicit = optionalToolObject(input, field);
  const body: Record<string, unknown> = explicit ? { ...explicit } : {};
  if (!explicit) {
    for (const key of fields) {
      const value = input[key];
      if (value !== undefined) body[key] = value;
    }
  }
  Object.assign(body, overrides);
  if (Object.keys(body).length === 0) {
    throw new Error(`Tool input ${field} or one of ${fields.join(", ")} is required`);
  }
  assertSafeJsonValue(body, field);
  return boundedJsonProviderNativeBody(body, field);
}

type AcquisitionToolArgs = {
  readonly approvalRequired?: boolean;
  readonly authorizationScopes?: readonly string[];
  readonly auditSelectorKeys?: readonly string[];
  readonly buildBody?: AcquisitionBodyBuilder;
  readonly buildHeaders?: ProviderNativeHttpToolDefinition["buildHeaders"];
  readonly buildUrl: AcquisitionUrlBuilder;
  readonly description: string;
  readonly effect: "execute" | "read" | "write";
  readonly egress?: ProviderNativeHttpToolDefinition["egress"];
  readonly expectedHost?: string;
  readonly filePrefix?: string;
  readonly handoffResultStatus?: "approved" | "published";
  readonly hostPolicy?: ProviderNativeHostPolicy;
  readonly hosts: readonly string[];
  readonly inputSchema: ProviderNativeInputSchema;
  readonly method: ProviderNativeHttpToolDefinition["method"];
  readonly provider: string;
  readonly requiredScopes?: readonly string[];
  readonly resourceTypes?: readonly string[];
  readonly retryPolicy?: ProviderNativeRetryPolicy;
  readonly sampleExternalAccountId?: string;
  readonly sampleInput: Readonly<Record<string, unknown>>;
  readonly toolName: string;
};

function effectMetadata(
  effect: AcquisitionToolArgs["effect"],
  approvalRequired: boolean,
): ProviderNativeEffectMetadata {
  if (approvalRequired) {
    return {
      allowedEffects: [effect],
      outboundMutation: true,
      writeRequiresApproval: true,
    };
  }
  return {
    allowedEffects: [effect],
    outboundMutation: false,
    writeRequiresApproval: false,
  };
}

function makeTool(args: AcquisitionToolArgs): ProviderNativeHttpToolDefinition {
  const approvalRequired = args.effect === "write" || args.approvalRequired === true;
  const hostPolicy =
    args.hostPolicy ?? ({ hosts: [...args.hosts], mode: "allowlist", requireHttps: true } as const);
  const selectorKeys = args.auditSelectorKeys ?? [
    "accountId",
    "projectId",
    "siteId",
    "publicationId",
    "campaignId",
    "formId",
    "baseUrl",
  ];
  const expectedHost = args.expectedHost ?? args.hosts[0];
  return {
    ...(args.authorizationScopes ? { authorizationScopes: [...args.authorizationScopes] } : {}),
    ...(args.auditSelectorKeys || args.resourceTypes
      ? {
          auditMetadata: {
            resourceTargets: {
              requireProofWhenConstrained: true,
              selectors: [
                {
                  constraintKey: args.resourceTypes?.[0] ?? "account",
                  defaultFromAuthorization: true,
                  inputKeys: [...selectorKeys],
                  required: false,
                },
              ],
            },
          },
        }
      : {}),
    ...(args.buildBody ? { buildBody: args.buildBody } : {}),
    ...(args.buildHeaders ? { buildHeaders: args.buildHeaders } : {}),
    ...(args.handoffResultStatus ? { handoffResultStatus: args.handoffResultStatus } : {}),
    conformanceMetadata: {
      ...(hostPolicy.mode === "allowlist" && expectedHost ? { expectedHost } : {}),
      requiredChecks: [
        "schemas",
        "hosts",
        "scopes",
        "effects",
        "secret_redaction",
        "retry_rate_limit",
        ...(approvalRequired ? ["runtime_idempotency_key"] : []),
      ],
      ...(args.sampleExternalAccountId
        ? { sampleExternalAccountId: args.sampleExternalAccountId }
        : {}),
      sampleInput: args.sampleInput,
    },
    defaultPolicyAction: approvalRequired ? "require_approval" : "allow",
    description: args.description,
    effect: args.effect,
    effectMetadata: effectMetadata(args.effect, approvalRequired),
    ...(args.egress ? { egress: args.egress } : {}),
    filePrefix: args.filePrefix ?? args.toolName.replace(/[^a-z0-9]+/giu, "-"),
    hostPolicy,
    inputSchema: args.inputSchema,
    method: args.method,
    provider: args.provider,
    rateLimitPolicy: ACQUISITION_RATE_LIMIT_POLICY,
    ...(args.resourceTypes
      ? {
          resourceMetadata: {
            authorizationRequired: true,
            resourceTypes: args.resourceTypes,
            selectorKeys: selectorKeys,
          },
        }
      : { resourceMetadata: { authorizationRequired: true, selectorKeys } }),
    requiredScopes: [...(args.requiredScopes ?? [])],
    retryPolicy: args.retryPolicy ?? ACQUISITION_RETRY_POLICY,
    successSummary: () => `${args.toolName} completed a ${args.effect} operation.`,
    toolName: args.toolName,
    ...(approvalRequired ? { handoffResultStatus: args.handoffResultStatus ?? "approved" } : {}),
    buildUrl: args.buildUrl,
  };
}

export function acquisitionRead(
  args: Omit<AcquisitionToolArgs, "effect" | "method"> & {
    readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  },
): ProviderNativeHttpToolDefinition {
  return makeTool({ ...args, effect: "read", method: args.method ?? "GET" });
}

export function acquisitionWrite(
  args: Omit<AcquisitionToolArgs, "effect">,
): ProviderNativeHttpToolDefinition {
  return makeTool({ ...args, effect: "write" });
}

export function id(input: Record<string, unknown>, key: string): string {
  return requireToolString(input, key);
}

export function optional(input: Record<string, unknown>, key: string): string | undefined {
  return optionalToolString(input, key);
}

export { requireHttpsOriginBaseUrl };
