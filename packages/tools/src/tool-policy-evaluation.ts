import {
  evaluateToolPolicy,
  type ToolPolicyAction,
  type ToolPolicyDecision,
} from "@deployments-ai/providers";
import { providerNativeHttpToolDefinitions } from "./provider-native/registry.ts";
import type { ToolAdapterDefinition } from "./types.ts";

const providerNativeDefinitions = new Map(
  providerNativeHttpToolDefinitions.map((definition) => [definition.toolName, definition] as const),
);

export function canonicalScopes(scopes: readonly string[] | undefined): readonly string[] {
  return [
    ...new Set((scopes ?? []).map((scope) => scope.trim()).filter((scope) => Boolean(scope))),
  ].sort();
}

export function isToolPolicyAction(value: unknown): value is ToolPolicyAction {
  return value === "allow" || value === "deny" || value === "require_approval";
}

/** Fills a policy document's missing default action and reason from the tool's catalog default. */
export function policyRulesWithCatalogDefault(
  rawRules: unknown,
  definition: ToolAdapterDefinition,
): unknown {
  const defaultReason = `Tool adapter ${definition.toolName} defaults to ${definition.defaultPolicyAction}.`;
  if (Array.isArray(rawRules)) {
    return {
      defaultAction: definition.defaultPolicyAction,
      defaultReason,
      rules: rawRules,
    };
  }
  if (!rawRules || typeof rawRules !== "object") {
    return {
      defaultAction: definition.defaultPolicyAction,
      defaultReason,
    };
  }
  const record = rawRules as Readonly<Record<string, unknown>>;
  return {
    ...record,
    defaultAction: isToolPolicyAction(record.defaultAction)
      ? record.defaultAction
      : definition.defaultPolicyAction,
    defaultReason:
      typeof record.defaultReason === "string" && record.defaultReason.trim()
        ? record.defaultReason.trim()
        : defaultReason,
  };
}

/**
 * The worker execution route for a definition, mirroring the runtime execution planner. `undefined`
 * means the runtime has no execution binding for the definition and denies it.
 */
export type ToolExecutionRoute =
  | "builtin"
  | "client"
  | "hosted_code"
  | "http_callback"
  | "mcp"
  | "provider_native"
  | "vendor_mcp";

export function toolExecutionRoute(
  definition: ToolAdapterDefinition,
): ToolExecutionRoute | undefined {
  const execution = definition.execution;
  const audit = definition.auditMetadata as { readonly mcpToolName?: unknown } | undefined;
  const mcpToolName =
    execution?.type === "mcp" || execution?.type === "vendor_mcp"
      ? execution.remoteToolName.trim()
      : typeof audit?.mcpToolName === "string"
        ? audit.mcpToolName.trim()
        : "";
  if (mcpToolName && execution?.type === "vendor_mcp") return "vendor_mcp";
  if (mcpToolName) return definition.effect === "read" ? "mcp" : undefined;
  const native = providerNativeDefinitions.get(definition.toolName);
  if (execution?.type === "client") return "client";
  if (execution?.type === "hosted_code") return native ? undefined : "hosted_code";
  if (execution?.type === "http_callback") return "http_callback";
  if (!native && execution?.type === "builtin" && execution.adapterKey?.trim()) return "builtin";
  return native?.effect === definition.effect ? "provider_native" : undefined;
}

/**
 * Which inputs decide a tool call. `catalog` tools (platform built-ins, hosted code, client tools)
 * are decided by the catalog default alone; environment tool policies never apply to them.
 * `connection` tools (provider-native, MCP, HTTP callback) are decided by the deployment-pinned
 * tool policy against the authorized connection's provider and granted scopes.
 */
export type ToolPolicyBinding = "catalog" | "connection";

export function toolPolicyBinding(route: ToolExecutionRoute): ToolPolicyBinding {
  return route === "builtin" || route === "client" || route === "hosted_code"
    ? "catalog"
    : "connection";
}

/** Inputs resolved from a deployment's workspace authorization for a `connection` tool. */
export interface ToolPolicyConnection {
  readonly connectorProvider: string;
  readonly grantedScopes?: readonly string[] | undefined;
  /** Rules of the deployment-pinned tool policy; absent when the binding pins none. */
  readonly policyRules?: unknown;
}

/**
 * Decides a tool call for an admitted definition exactly as runtime authorization does. Omit
 * `connection` for `catalog` tools: they ignore environment policies and hold no granted scopes.
 */
export function decideToolPolicy(
  definition: ToolAdapterDefinition,
  connection?: ToolPolicyConnection,
): ToolPolicyDecision {
  return evaluateToolPolicy(policyRulesWithCatalogDefault(connection?.policyRules, definition), {
    connectorProvider: connection?.connectorProvider ?? definition.provider ?? "builtin",
    effect: definition.effect,
    grantedScopes: connection ? canonicalScopes(connection.grantedScopes) : [],
    requiredScopes: canonicalScopes(definition.requiredScopes),
    toolName: definition.toolName,
  });
}

export type ToolCatalogStatus = "active" | "archived" | "unknown";

/** Catalog status of a resolved definition; unresolved and inactive tools are denied. */
export function toolCatalogStatus(
  toolName: string,
  definition: ToolAdapterDefinition | undefined,
): ToolCatalogStatus {
  if (!definition || definition.toolName !== toolName) return "unknown";
  return definition.status === "active" ? "active" : "archived";
}

/** The runtime's denial reason for a tool that is not registered or not active. */
export function toolCatalogDenial(toolName: string, status: ToolCatalogStatus): string | undefined {
  if (status === "unknown") return `Runtime tool ${toolName} is not registered.`;
  if (status === "archived") return `Runtime tool ${toolName} is not active.`;
  return undefined;
}
