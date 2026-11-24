import type { ToolEgress, Ulid } from "@deployments-ai/db";

export type ToolEffect = "read" | "write" | "execute";
export type ToolPolicyAction = "allow" | "require_approval" | "deny";
export type ToolAdapterStatus = "active" | "archived";

export interface ToolApprovalRequestMetadata {
  readonly diffArtifactIds?: readonly string[];
  readonly externalUrl?: string;
  readonly metadata?: Record<string, unknown>;
  readonly previewArtifactIds?: readonly string[];
  readonly riskLevel?: "low" | "medium" | "high";
  readonly rollback?: {
    readonly artifactIds?: readonly string[];
    readonly externalUrl?: string;
    readonly instructions?: string;
    readonly strategy?: string;
  };
  readonly summary?: string;
  readonly target?: {
    readonly accountId?: string;
    readonly displayName?: string;
    readonly externalUrl?: string;
    readonly resourceId?: string;
    readonly resourceType?: string;
  };
  readonly [key: string]: unknown;
}

export interface ToolAdapterBuiltinExecution {
  readonly adapterKey?: string;
  readonly type: "builtin";
}

export interface ToolAdapterHttpCallbackExecution {
  /** Runtime-only credential loaded from the vault; never persist or project this field. */
  readonly authorizationHeader?: string;
  /** Runtime-only non-secret generation pin included in approval fingerprints. */
  readonly credentialGeneration?: number;
  readonly completionMode: "sync";
  readonly endpointOrigin: string;
  readonly endpointPath: string;
  readonly runContext?: readonly "origin"[];
  readonly type: "http_callback";
  /** Thread-sandbox files (globs relative to `/workspace`) attached to every dispatch. */
  readonly workspaceFiles?: ToolAdapterCallbackWorkspaceFiles;
}

export interface ToolAdapterCallbackWorkspaceFiles {
  readonly include: readonly string[];
}

export interface ToolAdapterMcpExecution {
  readonly mcpServerId: string;
  readonly remoteToolName: string;
  readonly type: "mcp";
}

/**
 * Tool discovered on a vendor-hosted MCP server and synced into a tenant tool adapter. The
 * runtime fails closed when the advertised definition hash differs from `toolHash`.
 */
export interface ToolAdapterVendorMcpExecution {
  readonly providerKey: string;
  readonly remoteToolName: string;
  readonly toolHash: string;
  readonly type: "vendor_mcp";
}

/** Executed by the calling client; the run pauses until the client submits the tool output. */
export interface ToolAdapterClientExecution {
  readonly timeoutMs?: number;
  readonly type: "client";
}

/** Customer-authored function code executed by the worker in the agent sandbox. */
interface HostedCodeExecutionContract {
  readonly contentHash: string;
  readonly entrypoint: string;
  readonly language: "javascript" | "python";
  readonly memoryMiB: number;
  readonly network: "none" | "sandbox";
  readonly secretNames: readonly string[];
  readonly sourceLanguage: "javascript" | "python" | "typescript";
  readonly timeoutMs: number;
  readonly type: "hosted_code";
}

/**
 * Hosted code as declared on the tool adapter. The executable artifact location is only known once
 * a release or execution binding pins the declaration; see
 * {@link ToolAdapterPinnedHostedCodeExecution}.
 */
export interface ToolAdapterHostedCodeExecution extends HostedCodeExecutionContract {
  readonly artifact?: undefined;
}

/**
 * Hosted code resolved from a release or execution binding pin, so every field (including the
 * artifact location) is immutable for that pin. Only pinned hosted code can execute.
 */
export interface ToolAdapterPinnedHostedCodeExecution extends HostedCodeExecutionContract {
  readonly artifact: {
    readonly bucket: string;
    readonly byteSize: number;
    readonly key: string;
    readonly versionId: string;
  };
  /** Runtime-only non-secret vault pin included in plan fingerprints; never persisted. */
  readonly credential?: { readonly credentialId: Ulid; readonly generation: number };
}

export type ToolAdapterExecution =
  | ToolAdapterBuiltinExecution
  | ToolAdapterClientExecution
  | ToolAdapterHostedCodeExecution
  | ToolAdapterHttpCallbackExecution
  | ToolAdapterMcpExecution
  | ToolAdapterPinnedHostedCodeExecution
  | ToolAdapterVendorMcpExecution;

export interface ToolAdapterDefinition {
  readonly approvalRequestMetadata?: ToolApprovalRequestMetadata;
  /** Provider OAuth/installation permissions needed to authorize this tool. */
  readonly authorizationScopes?: readonly string[];
  readonly auditMetadata?: unknown;
  readonly hostPolicy?: unknown;
  readonly connectorAccountId?: string;
  readonly defaultPolicyAction: ToolPolicyAction;
  readonly description: string;
  readonly effect: ToolEffect;
  /**
   * Where a builtin tool can send organization data; read only for builtin execution. It sits
   * outside `execution` so plan fingerprints and pending approvals do not change.
   */
  readonly egress?: ToolEgress;
  readonly execution?: ToolAdapterExecution;
  readonly inputSchema?: unknown;
  /** JSON Schema for structured output (client-submitted or returned by hosted code). */
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly provider?: string;
  /**
   * When true (typically for write effect), this adapter performs outbound
   * provider/connector mutation I/O and must acquire a mutation claim first.
   */
  readonly providerOutboundMutation?: boolean;
  readonly rateLimitPolicy?: unknown;
  readonly requiredScopes?: readonly string[];
  readonly resourceMetadata?: unknown;
  readonly retryPolicy?: unknown;
  readonly status?: ToolAdapterStatus;
  /** Durable adapter identity when this definition was loaded from the control plane. */
  readonly toolAdapterId?: Ulid;
  readonly toolName: string;
}
