import {
  appendNativeQueryFields,
  optionalToolString,
  requireToolString,
  type ProviderAccessToken,
  type ProviderNativeBody,
  type ProviderNativeEffectMetadata,
  type ProviderNativeHttpToolDefinition,
  type ProviderNativeInputSchema,
  type ProviderNativeToolRequestContext,
} from "../core.ts";
import { staticProviderUrl } from "../tool-definition-builders.ts";

const BUSINESS_RETRY_POLICY = Object.freeze({
  baseDelayMs: 250,
  maxAttempts: 3,
  maxDelayMs: 2_000,
  respectRetryAfter: true,
  retryableStatusCodes: Object.freeze([408, 425, 429, 500, 502, 503, 504]),
});

const BUSINESS_RATE_LIMIT_POLICY = Object.freeze({
  maxConcurrentRequests: 4,
  maxRequestsPerWindow: 60,
  retryAfterHeader: "retry-after",
  windowMs: 60_000,
});

export function queryProviderUrl(
  host: string,
  pathSegments: readonly string[],
  input: Record<string, unknown>,
  fields: readonly string[],
): string {
  const url = new URL(staticProviderUrl(host, pathSegments));
  appendNativeQueryFields(url, input, fields);
  return url.toString();
}

export function bearerHeaders(_input: Record<string, unknown>, token: ProviderAccessToken) {
  if (!token.token.trim()) throw new Error("Provider credential token is required");
  return { authorization: `Bearer ${token.token.trim()}` };
}

export function twilioFormBody(input: Record<string, unknown>): ProviderNativeBody {
  const to = requireE164(input, "to");
  const from = requireE164(input, "from");
  const body = requireToolString(input, "body");
  const form = new URLSearchParams({ Body: body, From: from, To: to });
  const mediaUrls = input.mediaUrls;
  if (Array.isArray(mediaUrls)) {
    mediaUrls.forEach((mediaUrl) => {
      if (typeof mediaUrl !== "string" || !mediaUrl.trim()) {
        throw new Error("Tool input mediaUrls must contain non-empty strings");
      }
      form.append("MediaUrl", mediaUrl.trim());
    });
  }
  return { body: form, contentType: "application/x-www-form-urlencoded" };
}

export function plivoJsonBody(input: Record<string, unknown>): ProviderNativeBody {
  const src = requireE164(input, "src");
  const dst = requireE164(input, "dst");
  const text = requireToolString(input, "text");
  const body: Record<string, unknown> = { dst, log: "false", src, text };
  for (const key of ["url", "method"] as const) {
    const value = optionalToolString(input, key);
    if (value) body[key] = value;
  }
  return { body: JSON.stringify(body), contentType: "application/json" };
}

function requireE164(input: Record<string, unknown>, key: string): string {
  const value = requireToolString(input, key);
  if (!/^\+[1-9]\d{6,14}$/u.test(value)) {
    throw new Error(`Tool input ${key} must be an E.164 phone number`);
  }
  return value;
}

type BusinessToolArgs = {
  readonly auditSelectorKeys?: readonly string[];
  readonly authorizationScopes?: readonly string[];
  readonly buildBody?: ProviderNativeHttpToolDefinition["buildBody"];
  readonly buildHeaders?: ProviderNativeHttpToolDefinition["buildHeaders"];
  readonly buildUrl: (
    input: Record<string, unknown>,
    token: ProviderAccessToken,
    request: ProviderNativeToolRequestContext,
  ) => string;
  readonly description: string;
  readonly effect: "read" | "write";
  readonly egress?: ProviderNativeHttpToolDefinition["egress"];
  readonly expectedHost: string;
  readonly filePrefix?: string;
  readonly hosts: readonly string[];
  readonly inputSchema: ProviderNativeInputSchema;
  readonly method: ProviderNativeHttpToolDefinition["method"];
  readonly provider: string;
  readonly requiredScopes?: readonly string[];
  readonly resourceTypes: readonly string[];
  readonly sampleInput?: Readonly<Record<string, unknown>>;
  readonly toolName: string;
  readonly verificationPath?: string;
  readonly deferredReason?: string;
};

function effectMetadata(effect: BusinessToolArgs["effect"]): ProviderNativeEffectMetadata {
  if (effect === "write") {
    return {
      allowedEffects: ["write"],
      outboundMutation: true,
      writeRequiresApproval: true,
    };
  }
  return {
    allowedEffects: ["read"],
    outboundMutation: false,
    writeRequiresApproval: false,
  };
}

function makeTool(args: BusinessToolArgs): ProviderNativeHttpToolDefinition {
  const selectorKeys = args.auditSelectorKeys ?? [
    "accountId",
    "accountSid",
    "authId",
    "workspaceId",
  ];
  const deferred = Boolean(args.deferredReason);
  const buildUrl = deferred
    ? () => {
        throw new Error(`${args.provider} adapter is deferred: ${args.deferredReason}`);
      }
    : args.buildUrl;

  return {
    ...(args.authorizationScopes ? { authorizationScopes: [...args.authorizationScopes] } : {}),
    ...(args.buildBody ? { buildBody: args.buildBody } : {}),
    ...(args.buildHeaders ? { buildHeaders: args.buildHeaders } : {}),
    auditMetadata: {
      resourceTargets: {
        requireProofWhenConstrained: true,
        selectors: [
          {
            constraintKey: args.resourceTypes[0] ?? "account",
            defaultFromAuthorization: true,
            inputKeys: [...selectorKeys],
            required: false,
          },
        ],
      },
    },
    conformanceMetadata: {
      expectedHost: args.expectedHost,
      requiredChecks: [
        "schemas",
        "hosts",
        "scopes",
        "effects",
        "secret_redaction",
        "retry_rate_limit",
      ],
      ...(args.sampleInput && !deferred ? { sampleInput: args.sampleInput } : {}),
    },
    defaultPolicyAction: deferred ? "deny" : args.effect === "write" ? "require_approval" : "allow",
    description: args.description,
    effect: args.effect,
    effectMetadata: effectMetadata(args.effect),
    ...(args.egress ? { egress: args.egress } : {}),
    filePrefix: args.filePrefix ?? args.toolName.replace(/[^a-z0-9]+/giu, "-"),
    hostPolicy: { hosts: [...args.hosts], mode: "allowlist", requireHttps: true },
    inputSchema: args.inputSchema,
    method: args.method,
    provider: args.provider,
    rateLimitPolicy: BUSINESS_RATE_LIMIT_POLICY,
    resourceMetadata: {
      authorizationRequired: true,
      resourceTypes: [...args.resourceTypes],
      selectorKeys: [...selectorKeys],
    },
    retryPolicy: BUSINESS_RETRY_POLICY,
    requiredScopes: [...(args.requiredScopes ?? [])],
    successSummary: () =>
      deferred
        ? `${args.provider} ${args.toolName} is deferred pending verified provider route documentation.`
        : args.effect === "write"
          ? `${args.provider} ${args.toolName} completed after approval.`
          : `${args.provider} ${args.toolName} completed.`,
    toolName: args.toolName,
    ...(args.effect === "write" && !deferred ? { handoffResultStatus: "approved" as const } : {}),
    ...(args.verificationPath && !deferred
      ? {
          verificationProbe: {
            expectedStatusCodes: [200],
            method: "GET" as const,
            path: args.verificationPath,
            timeoutMs: 5_000,
          },
        }
      : {}),
    buildUrl,
  };
}

export function businessRead(
  args: Omit<BusinessToolArgs, "effect" | "method"> & {
    readonly method?: BusinessToolArgs["method"];
  },
): ProviderNativeHttpToolDefinition {
  return makeTool({ ...args, effect: "read", method: args.method ?? "GET" });
}

export function businessWrite(
  args: Omit<BusinessToolArgs, "effect">,
): ProviderNativeHttpToolDefinition {
  return makeTool({ ...args, effect: "write" });
}

export function deferredBusinessRead(
  args: Omit<BusinessToolArgs, "effect" | "method" | "buildUrl"> & {
    readonly method?: BusinessToolArgs["method"];
    readonly deferredReason: string;
  },
): ProviderNativeHttpToolDefinition {
  return makeTool({
    ...args,
    buildUrl: () => "https://deferred.invalid/never-executed",
    effect: "read",
    method: args.method ?? "GET",
  });
}
