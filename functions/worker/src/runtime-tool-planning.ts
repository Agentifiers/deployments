import type {
  AgentRunIdentity,
  AgentRuntimeDependencies,
  RuntimeBrainEvidenceContextItem,
  RuntimeCompletedToolCall,
  RuntimeTenantScope,
  RuntimeToolAllowedDecision,
  RuntimeToolExecutionBinding,
  RuntimeToolExecutionResult,
  RuntimeToolRequest,
  RuntimeToolTraceContext,
  RuntimeSandboxPolicy,
} from "@deployments-ai/agent-runtime";
import type {
  CallbackDispatchControlAuthorizationSnapshot,
  OrganizationDataBoundaryReader,
  OrganizationEgressAllowlistReader,
  Ulid,
} from "@deployments-ai/db";
import { codeProviderDefinitionRegistry } from "@deployments-ai/providers";
import {
  canonicalScopes,
  executeProviderNativeHttpTool,
  providerNativeHttpToolDefinitions,
  type ProviderNativeCredential,
  type ProviderNativeHttpExecutorOptions,
  type ProviderNativeHttpToolDefinition,
  type ToolAdapterDefinition,
  type ToolAdapterCallbackWorkspaceFiles,
  type ToolAdapterClientExecution,
  type ToolAdapterPinnedHostedCodeExecution,
  type ToolAdapterHttpCallbackExecution,
  type ToolAdapterVendorMcpExecution,
} from "@deployments-ai/tools";
import { createHash } from "node:crypto";
import { type RuntimeProviderMutationClaimStore } from "./provider-mutation-claims.ts";
import type { RuntimeCallbackWorkspaceFile } from "./runtime-http-callback.ts";
import type {
  AssertHttpCallbackSendable,
  RuntimeHttpCallbackDispatch,
} from "./runtime-http-callback-dispatch.ts";

export { providerMutationRequestIdempotencyKey } from "./runtime-idempotency.ts";

export const DEFAULT_RUNTIME_PROVIDER_ARTIFACT_MAX_CHARACTERS = 48_000;
export const BUILTIN_EXECUTION_CONNECTION_ID = "00000000000000000000000000" as Ulid;
/** Executor-map key for data-owned hosted code adapters; never a catalog tool name. */
export const HOSTED_CODE_EXECUTOR_KEY = "hosted_code";

export type RuntimeToolBindingRequest = RuntimeToolRequest &
  RuntimeTenantScope &
  AgentRunIdentity &
  RuntimeToolTraceContext & {
    readonly approvalId?: Ulid;
    readonly brainEvidence?: readonly RuntimeBrainEvidenceContextItem[];
    readonly completedToolCalls?: readonly RuntimeCompletedToolCall[];
    readonly recordedArtifactIds?: readonly Ulid[];
    readonly policyAction?: "allow" | "require-approval";
    readonly executionKind?: "agent-run" | "workflow";
    readonly sandboxPolicy?: RuntimeSandboxPolicy;
    readonly signal?: AbortSignal;
  };

export interface RuntimeToolAuthorizationContext {
  readonly authorizationFingerprint: string;
  readonly callbackControlSnapshot?: CallbackDispatchControlAuthorizationSnapshot;
  readonly connectionId: Ulid;
  readonly connectorProvider: string;
  readonly externalAccountId: string;
  readonly externalResourceConstraints?: Readonly<Record<string, unknown>>;
  readonly grantedScopes?: readonly string[];
  readonly policyRules?: unknown;
}

export type ResolveRuntimeToolAuthorizationContext = (
  request: RuntimeToolBindingRequest,
  definition: ToolAdapterDefinition,
) => Promise<RuntimeToolAuthorizationContext | undefined>;

export type ExecuteRuntimeMcpTool = (
  request: AuthorizedRuntimeToolBindingRequest,
  definition: ToolAdapterDefinition,
  mcpToolName: string,
) => Promise<RuntimeToolExecutionResult>;

/**
 * Executes a synced vendor MCP tool (read or mutation). Mutations must throw
 * `RuntimeProviderMutationOutcomeUnknownError` for any failure after `tools/call` may have
 * reached the server; earlier failures are known or retryable tool errors.
 */
export type ExecuteRuntimeVendorMcpTool = (
  request: AuthorizedRuntimeToolBindingRequest,
  definition: ToolAdapterDefinition,
  execution: ToolAdapterVendorMcpExecution,
) => Promise<RuntimeToolExecutionResult>;

export type ResolveRuntimeProviderCredential = (
  request: AuthorizedRuntimeToolBindingRequest,
  definition: ProviderNativeHttpToolDefinition,
) => Promise<ProviderNativeCredential>;

export interface PreparedRuntimeProviderInput {
  readonly input: Readonly<Record<string, unknown>>;
  readonly persistCanonicalHandoffResponse?: boolean;
  readonly releaseOnRetry?: () => Promise<void>;
}

export type PrepareRuntimeProviderInput = (
  request: AuthorizedRuntimeToolBindingRequest,
  definition: ProviderNativeHttpToolDefinition,
) => Promise<PreparedRuntimeProviderInput>;

export interface RuntimeBuiltinApproval {
  readonly action: "allow" | "require_approval";
  readonly reason: string;
}

export interface ExecuteRuntimeBuiltinTool {
  (
    request: RuntimeToolBindingRequest & { readonly decision: RuntimeToolAllowedDecision },
    definition: ToolAdapterDefinition,
  ): Promise<RuntimeToolExecutionResult>;
  refreshReplay?: (
    request: RuntimeToolBindingRequest & { readonly decision: RuntimeToolAllowedDecision },
    definition: ToolAdapterDefinition,
    persistedResult: RuntimeToolExecutionResult,
  ) => Promise<RuntimeToolExecutionResult>;
  mutationClaimResult?: (result: RuntimeToolExecutionResult) => RuntimeToolExecutionResult;
  /**
   * Checked before any mutation claim or execution. A returned result completes the call as-is
   * (model-visible) and the executor is never invoked.
   */
  preflight?: (
    request: RuntimeToolBindingRequest & { readonly decision: RuntimeToolAllowedDecision },
  ) => RuntimeToolExecutionResult | undefined;
  approval?: (
    request: RuntimeToolRequest & RuntimeTenantScope & AgentRunIdentity,
  ) => Promise<RuntimeBuiltinApproval>;
}

export type AuthorizedRuntimeToolBindingRequest = RuntimeToolBindingRequest & {
  readonly decision: RuntimeToolAllowedDecision & {
    readonly executionBinding: RuntimeToolExecutionBinding;
  };
};

export type ReadRuntimeCallbackWorkspaceFiles = (
  request: AuthorizedRuntimeToolBindingRequest,
  spec: ToolAdapterCallbackWorkspaceFiles,
) => Promise<readonly RuntimeCallbackWorkspaceFile[]>;

export interface RuntimeToolBindingOptions {
  readonly builtinExecutors?: Readonly<Record<string, ExecuteRuntimeBuiltinTool>>;
  /** Read for every tool whose egress some data boundary refuses; a read error fails closed. */
  readonly dataBoundaries: OrganizationDataBoundaryReader;
  /** Read only for a per-call gated tool inside a restricted boundary; a read error fails closed. */
  readonly egressAllowlists: OrganizationEgressAllowlistReader;
  readonly executeMcpTool?: ExecuteRuntimeMcpTool;
  readonly executeVendorMcpTool?: ExecuteRuntimeVendorMcpTool;
  readonly executor?: ProviderNativeHttpExecutorOptions;
  readonly generateId: () => Promise<Ulid>;
  readonly isToolAvailable?: (toolName: string) => boolean;
  readonly maxArtifactCharacters?: number;
  readonly mutationClaims?: RuntimeProviderMutationClaimStore;
  /**
   * Reads the thread-sandbox files an HTTP callback execution declares in `workspaceFiles`.
   * Absent when the worker has no thread-persistent sandboxes; such callbacks then fail.
   */
  readonly readCallbackWorkspaceFiles?: ReadRuntimeCallbackWorkspaceFiles;
  readonly persistHttpCallbackDispatch?: (
    request: AuthorizedRuntimeToolBindingRequest,
    effectiveInput: Readonly<Record<string, unknown>>,
    control: CallbackDispatchControlAuthorizationSnapshot | undefined,
    runContext: ToolAdapterHttpCallbackExecution["runContext"],
    assertSendable: AssertHttpCallbackSendable,
  ) => Promise<RuntimeHttpCallbackDispatch>;
  readonly prepareProviderInput?: PrepareRuntimeProviderInput;
  readonly resolveMcpAuthorizationContext?: ResolveRuntimeToolAuthorizationContext;
  readonly resolveVendorMcpAuthorizationContext?: ResolveRuntimeToolAuthorizationContext;
  readonly resolveAuthorizationContext: ResolveRuntimeToolAuthorizationContext;
  readonly resolveExtensionToolDefinition?: (
    toolName: string,
    context: RuntimeTenantScope & AgentRunIdentity,
  ) => Promise<ToolAdapterDefinition | undefined>;
  readonly resolveProviderCredential: ResolveRuntimeProviderCredential;
}

export type RuntimeToolService = Required<
  Pick<AgentRuntimeDependencies, "authorizeToolCall" | "executeToolCall" | "resolveToolDefinition">
>;
export type RuntimeToolDependencies = RuntimeToolService;

export const providerNativeDefinitions = new Map(
  providerNativeHttpToolDefinitions.map((definition) => [definition.toolName, definition] as const),
);

export interface RuntimeToolExecutionPlanBase {
  readonly adapter: ToolAdapterDefinition;
  readonly effect: RuntimeToolRequest["effect"];
  readonly fingerprint: string;
  readonly requiredScopes: readonly string[];
}

/** Remote MCP read: tenant MCP servers (no `vendor`) or synced vendor MCP tools. */
export interface RuntimeMcpReadExecutionPlan extends RuntimeToolExecutionPlanBase {
  readonly effect: "read";
  readonly kind: "mcp-read";
  readonly mcpToolName: string;
  readonly vendor?: ToolAdapterVendorMcpExecution;
}

/** Vendor MCP write; claimed before dispatch and never redispatched after an unknown outcome. */
export interface RuntimeMcpMutationExecutionPlan extends RuntimeToolExecutionPlanBase {
  readonly effect: "execute" | "write";
  readonly kind: "mcp-mutation";
  readonly mcpToolName: string;
  readonly vendor: ToolAdapterVendorMcpExecution;
}

export interface RuntimeBuiltinExecutionPlan extends RuntimeToolExecutionPlanBase {
  readonly adapterKey: string;
  readonly executor: ExecuteRuntimeBuiltinTool;
  readonly kind: "builtin";
}

export interface RuntimeProviderReadExecutionPlan extends RuntimeToolExecutionPlanBase {
  readonly definition: ProviderNativeHttpToolDefinition;
  readonly effect: "read";
  readonly kind: "provider-read";
}

export interface RuntimeProviderMutationExecutionPlan extends RuntimeToolExecutionPlanBase {
  readonly definition: ProviderNativeHttpToolDefinition;
  readonly effect: "execute" | "write";
  readonly kind: "provider-mutation";
}

export interface RuntimeHttpCallbackExecutionPlan extends RuntimeToolExecutionPlanBase {
  readonly execution: ToolAdapterHttpCallbackExecution;
  readonly kind: "http-callback";
}

export interface RuntimeClientExecutionPlan extends RuntimeToolExecutionPlanBase {
  readonly execution: ToolAdapterClientExecution;
  readonly kind: "client";
}

/** Release-pinned customer code; executed through the connectionless built-in path. */
export interface RuntimeHostedCodeExecutionPlan extends RuntimeToolExecutionPlanBase {
  readonly adapterKey: typeof HOSTED_CODE_EXECUTOR_KEY;
  readonly execution: ToolAdapterPinnedHostedCodeExecution;
  readonly executor: ExecuteRuntimeBuiltinTool;
  readonly kind: "hosted-code";
}

export type RuntimeToolExecutionPlan =
  | RuntimeBuiltinExecutionPlan
  | RuntimeClientExecutionPlan
  | RuntimeHostedCodeExecutionPlan
  | RuntimeHttpCallbackExecutionPlan
  | RuntimeMcpMutationExecutionPlan
  | RuntimeMcpReadExecutionPlan
  | RuntimeProviderMutationExecutionPlan
  | RuntimeProviderReadExecutionPlan;

export class RuntimeToolPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeToolPlanError";
  }
}

export function mcpToolName(definition: ToolAdapterDefinition): string | undefined {
  if (definition.execution?.type === "mcp" || definition.execution?.type === "vendor_mcp") {
    const value = definition.execution.remoteToolName.trim();
    return value || undefined;
  }
  if (!definition.auditMetadata || typeof definition.auditMetadata !== "object") return undefined;
  const value = (definition.auditMetadata as Readonly<Record<string, unknown>>).mcpToolName;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function canonicalPlanValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalPlanValue);
  if (!value || typeof value !== "object") return undefined;
  return Object.fromEntries(
    Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .flatMap(([key, entry]) => {
        const canonical = canonicalPlanValue(entry);
        return canonical === undefined ? [] : [[key, canonical] as const];
      }),
  );
}

export function toolPlanFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalPlanValue(value)))
    .digest("hex");
}

export function executionPlan(
  adapter: ToolAdapterDefinition,
  builtinExecutors: RuntimeToolBindingOptions["builtinExecutors"],
): RuntimeToolExecutionPlan {
  if (adapter.status !== "active") {
    throw new RuntimeToolPlanError(`Runtime tool ${adapter.toolName} is not active.`);
  }
  const requiredScopes = canonicalScopes(adapter.requiredScopes);
  const remoteMcpToolName = mcpToolName(adapter);
  const nativeDefinition = providerNativeDefinitions.get(adapter.toolName);
  const adapterKey =
    adapter.execution?.type === "builtin" ? adapter.execution.adapterKey?.trim() : undefined;
  const callbackExecution =
    adapter.execution?.type === "http_callback" ? adapter.execution : undefined;
  const fingerprintExecution = callbackExecution
    ? {
        completionMode: callbackExecution.completionMode,
        credentialGeneration: callbackExecution.credentialGeneration,
        endpointOrigin: callbackExecution.endpointOrigin,
        endpointPath: callbackExecution.endpointPath,
        runContext: callbackExecution.runContext,
        type: callbackExecution.type,
        workspaceFiles: callbackExecution.workspaceFiles,
      }
    : adapter.execution;
  const builtinExecutor = adapterKey ? builtinExecutors?.[adapterKey] : undefined;
  if (remoteMcpToolName && nativeDefinition) {
    throw new RuntimeToolPlanError(
      `Runtime tool ${adapter.toolName} has ambiguous worker execution bindings.`,
    );
  }
  const adapterPlan = {
    auditMetadata: adapter.auditMetadata,
    defaultPolicyAction: adapter.defaultPolicyAction,
    effect: adapter.effect,
    execution: fingerprintExecution,
    inputSchema: adapter.inputSchema,
    outputSchema: adapter.outputSchema,
    provider: adapter.provider,
    providerOutboundMutation: adapter.providerOutboundMutation,
    requiredScopes,
    toolAdapterId: adapter.toolAdapterId,
    toolName: adapter.toolName,
  };
  if (remoteMcpToolName && adapter.execution?.type === "vendor_mcp") {
    const vendor = adapter.execution;
    if (!vendor.providerKey.trim() || !vendor.toolHash.trim()) {
      throw new RuntimeToolPlanError(
        `Runtime vendor MCP tool ${adapter.toolName} has an incomplete execution binding.`,
      );
    }
    const backend = {
      providerKey: vendor.providerKey,
      remoteToolName: remoteMcpToolName,
      toolHash: vendor.toolHash,
    };
    const base = { adapter, mcpToolName: remoteMcpToolName, requiredScopes, vendor };
    return adapter.effect === "read"
      ? {
          ...base,
          effect: "read",
          fingerprint: toolPlanFingerprint({
            adapter: adapterPlan,
            backend: { ...backend, kind: "mcp-read" },
          }),
          kind: "mcp-read",
        }
      : {
          ...base,
          effect: adapter.effect,
          fingerprint: toolPlanFingerprint({
            adapter: adapterPlan,
            backend: { ...backend, kind: "mcp-mutation" },
          }),
          kind: "mcp-mutation",
        };
  }
  if (remoteMcpToolName) {
    if (adapter.effect !== "read") {
      throw new RuntimeToolPlanError(
        `Runtime MCP tool ${adapter.toolName} requires unsupported mutation semantics.`,
      );
    }
    return {
      adapter,
      effect: "read",
      fingerprint: toolPlanFingerprint({
        adapter: adapterPlan,
        backend: { kind: "mcp-read", mcpToolName: remoteMcpToolName },
      }),
      kind: "mcp-read",
      mcpToolName: remoteMcpToolName,
      requiredScopes,
    };
  }
  if (adapter.execution?.type === "client") {
    return {
      adapter,
      effect: adapter.effect,
      execution: adapter.execution,
      fingerprint: toolPlanFingerprint({
        adapter: adapterPlan,
        backend: { kind: "client" },
      }),
      kind: "client",
      requiredScopes,
    };
  }
  if (adapter.execution?.type === "hosted_code") {
    const executor = builtinExecutors?.[HOSTED_CODE_EXECUTOR_KEY];
    if (!executor || nativeDefinition || !adapter.execution.artifact) {
      throw new RuntimeToolPlanError(
        `Runtime tool ${adapter.toolName} has no hosted code execution binding.`,
      );
    }
    return {
      adapter,
      adapterKey: HOSTED_CODE_EXECUTOR_KEY,
      effect: adapter.effect,
      execution: adapter.execution,
      executor,
      fingerprint: toolPlanFingerprint({
        adapter: adapterPlan,
        backend: { contentHash: adapter.execution.contentHash, kind: "hosted-code" },
      }),
      kind: "hosted-code",
      requiredScopes,
    };
  }
  if (callbackExecution) {
    return {
      adapter,
      effect: adapter.effect,
      execution: callbackExecution,
      fingerprint: toolPlanFingerprint({
        adapter: adapterPlan,
        backend: {
          endpointOrigin: callbackExecution.endpointOrigin,
          endpointPath: callbackExecution.endpointPath,
          kind: "http-callback",
        },
      }),
      kind: "http-callback",
      requiredScopes,
    };
  }
  if (!nativeDefinition && builtinExecutor && adapterKey) {
    return {
      adapter,
      adapterKey,
      effect: adapter.effect,
      executor: builtinExecutor,
      fingerprint: toolPlanFingerprint({
        adapter: adapterPlan,
        backend: { adapterKey, kind: "builtin" },
      }),
      kind: "builtin",
      requiredScopes,
    };
  }
  if (!nativeDefinition) {
    throw new RuntimeToolPlanError(
      `Runtime tool ${adapter.toolName} has no worker execution binding.`,
    );
  }
  if (nativeDefinition.effect !== adapter.effect) {
    throw new RuntimeToolPlanError(
      `Runtime tool ${adapter.toolName} has inconsistent catalog effects.`,
    );
  }
  const kind = adapter.effect === "read" ? "provider-read" : "provider-mutation";
  const fingerprint = toolPlanFingerprint({
    adapter: adapterPlan,
    backend: {
      acceptedProviders: [...(nativeDefinition.acceptedProviders ?? [nativeDefinition.provider])]
        .map(canonicalProvider)
        .toSorted(),
      authorizationScopes: nativeDefinition.authorizationScopes,
      effect: nativeDefinition.effect,
      effectMetadata: nativeDefinition.effectMetadata,
      hostPolicy: nativeDefinition.hostPolicy,
      inputSchema: nativeDefinition.inputSchema,
      kind,
      method: nativeDefinition.method,
      provider: canonicalProvider(nativeDefinition.provider),
      requiredScopes: canonicalScopes(nativeDefinition.requiredScopes),
      resourceMetadata: nativeDefinition.resourceMetadata,
      retryPolicy: nativeDefinition.retryPolicy,
      toolName: nativeDefinition.toolName,
    },
  });
  return adapter.effect === "read"
    ? {
        adapter,
        definition: nativeDefinition,
        effect: "read",
        fingerprint,
        kind: "provider-read",
        requiredScopes,
      }
    : {
        adapter,
        definition: nativeDefinition,
        effect: adapter.effect,
        fingerprint,
        kind: "provider-mutation",
        requiredScopes,
      };
}

export function sameScopes(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(canonicalScopes(left)) === JSON.stringify(canonicalScopes(right));
}

export function assertExecutionPlanMatches(
  binding: RuntimeToolExecutionBinding,
  request: RuntimeToolBindingRequest,
  plan: RuntimeToolExecutionPlan,
): void {
  if (binding.toolAdapterId !== plan.adapter.toolAdapterId) {
    throw new Error(`Runtime tool ${request.toolName} adapter changed after authorization.`);
  }
  if (binding.toolPlanFingerprint) {
    if (binding.toolPlanFingerprint !== plan.fingerprint) {
      throw new Error(`Runtime tool ${request.toolName} plan changed after authorization.`);
    }
    return;
  }
  if (
    request.effect !== plan.effect ||
    !sameScopes(plan.requiredScopes, request.requiredScopes ?? [])
  ) {
    throw new Error(`Runtime tool ${request.toolName} legacy plan changed after authorization.`);
  }
}

export function builtinExecutionBinding(
  plan: RuntimeBuiltinExecutionPlan | RuntimeHostedCodeExecutionPlan,
): RuntimeToolExecutionBinding {
  return {
    authorizationFingerprint: `builtin:${plan.adapterKey}`,
    connectionId: BUILTIN_EXECUTION_CONNECTION_ID,
    externalAccountId: plan.adapterKey,
    ...(plan.adapter.toolAdapterId ? { toolAdapterId: plan.adapter.toolAdapterId } : {}),
    toolPlanFingerprint: plan.fingerprint,
  };
}

export function positiveArtifactLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_RUNTIME_PROVIDER_ARTIFACT_MAX_CHARACTERS;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("maxArtifactCharacters must be a positive safe integer.");
  }
  return limit;
}

export function canonicalProvider(value: string): string {
  return codeProviderDefinitionRegistry().resolve(value)?.key ?? value.trim().replaceAll("-", "_");
}

export function acceptsProvider(
  definition: ProviderNativeHttpToolDefinition,
  provider: string,
): boolean {
  const normalized = canonicalProvider(provider);
  return (definition.acceptedProviders ?? [definition.provider]).some(
    (accepted) => canonicalProvider(accepted) === normalized,
  );
}

export function safeFileSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
}

export function runtimeArtifact(
  result: Awaited<ReturnType<typeof executeProviderNativeHttpTool>>,
  definition: ProviderNativeHttpToolDefinition,
  artifactIdentity: string,
  toolCallId: Ulid,
  maximumCharacters: number,
) {
  const sourceIsJson = result.contentType.toLowerCase().includes("json");
  const truncated = result.artifactBody.length > maximumCharacters;
  const artifactIsJson = sourceIsJson && !truncated;
  const body = result.artifactBody.trim()
    ? `${result.artifactBody.slice(0, maximumCharacters)}\n`
    : "{}\n";
  return {
    content: body,
    contentType: artifactIsJson ? "application/json" : "text/plain; charset=utf-8",
    fileName: `${safeFileSegment(artifactIdentity)}-${safeFileSegment(definition.filePrefix)}.${
      artifactIsJson ? "json" : "txt"
    }`,
    label: `${result.provider} provider API response`,
    metadata: {
      effect: definition.effect,
      method: definition.method,
      provider: result.provider,
      requestHost: result.requestHost,
      responseStatus: result.responseStatus,
      ...(truncated
        ? {
            originalCharacterCount: result.sourceCharacterCount,
            originalContentType: result.contentType || "application/octet-stream",
            truncated: true,
          }
        : {}),
      resultSummary: {
        effect: definition.effect,
        ...(result.itemCount === undefined ? {} : { itemCount: result.itemCount }),
        ok: true,
        status: result.responseStatus,
        toolName: definition.toolName,
      },
      source: "provider.native_http",
      toolCallId,
      toolName: definition.toolName,
    },
    type: "report",
    visibility: "private",
  } as const;
}

export function deny(reason: string, toolCallId: Ulid) {
  return { action: "deny" as const, reason, toolCallId };
}
