import type {
  AgentRunIdentity,
  RuntimeTenantScope,
  RuntimeToolAllowedDecision,
  RuntimeToolDecision,
  RuntimeToolExecutionBinding,
} from "@deployments-ai/agent-runtime";
import {
  RuntimeToolExecutionKnownFailureError,
  RuntimeToolPreparationRetryableError,
  runtimeToolInputHash,
} from "@deployments-ai/agent-runtime";
import {
  boundaryAdmitsEgress,
  decideEgress,
  describeEgressDestination,
  egressAdmittedByEveryProfile,
  type DataBoundary,
  type EgressDecision,
  type EgressDestination,
  type ToolEgress,
} from "@deployments-ai/db";
import {
  decideToolPolicy,
  findPlatformToolAdapterDefinition,
  hasPerCallEgressDecision,
  toolCatalogDenial,
  toolCatalogStatus,
  toolEgress,
  toolEgressDestinations,
  type ToolAdapterDefinition,
} from "@deployments-ai/tools";
import { CodedRunFailure } from "./agent-run-input.ts";
import { clientExecutionBinding } from "./client-runtime-tools.ts";
import {
  acceptsProvider,
  builtinExecutionBinding,
  canonicalProvider,
  deny,
  executionPlan,
  RuntimeToolPlanError,
  sameScopes,
  type RuntimeToolBindingOptions,
  type RuntimeToolBindingRequest,
  type RuntimeToolExecutionPlan,
  type RuntimeToolService,
} from "./runtime-tool-planning.ts";

export type RuntimeToolDefinitionLookupResult =
  | {
      readonly definition: ToolAdapterDefinition;
      /**
       * Set for a public-egress tool inside a boundary that refuses public egress but lets each
       * call through when its input names destinations: every authorization and execution then
       * decides the call's destinations against the organization's egress allowlist.
       */
      readonly egressGate?: PerCallEgressGate;
      readonly kind: "found";
    }
  | { readonly kind: "missing" }
  | ToolOutsideDataBoundary;

export interface PerCallEgressGate {
  readonly boundary: DataBoundary;
}

interface ToolOutsideDataBoundary {
  readonly boundary: DataBoundary;
  readonly egress: ToolEgress;
  readonly kind: "outside-boundary";
  readonly toolName: string;
}

export function toolOutsideDataBoundaryMessage(refusal: ToolOutsideDataBoundary): string {
  return `Tool ${refusal.toolName} can reach ${refusal.egress} destinations, which this organization's ${refusal.boundary.profile} data boundary does not allow.`;
}

export class ToolOutsideDataBoundaryError extends CodedRunFailure {
  constructor(refusal: ToolOutsideDataBoundary) {
    super("tool_outside_data_boundary", toolOutsideDataBoundaryMessage(refusal));
    this.name = "ToolOutsideDataBoundaryError";
  }
}

export function egressDenialMessage(toolName: string, gate: PerCallEgressGate, reason: string) {
  return `Tool ${toolName} would send data outside this organization's ${gate.boundary.profile} data boundary. ${reason}`;
}

/**
 * Decides one call of a per-call gated tool from its input and the organization's egress
 * allowlist. A failed allowlist read throws a retryable preparation error, like a failed
 * boundary read, so the call never proceeds on an unknown allowlist.
 */
export async function perCallEgressDecision(
  options: RuntimeToolBindingOptions,
  definition: ToolAdapterDefinition,
  request: {
    readonly input?: Readonly<Record<string, unknown>>;
    readonly organizationId: RuntimeTenantScope["organizationId"];
    readonly toolName: string;
  },
  gate: PerCallEgressGate,
): Promise<EgressDecision> {
  let allowlist;
  try {
    allowlist = await options.egressAllowlists.read(request.organizationId);
  } catch (cause) {
    throw new RuntimeToolPreparationRetryableError(request.toolName, cause);
  }
  return decideEgress(
    gate.boundary,
    allowlist,
    toolEgressDestinations(definition, request.input ?? {}),
  );
}

/** Digest of the destinations shown to an approver, independent of their order. */
function egressDestinationsHash(destinations: readonly EgressDestination[]): string {
  return runtimeToolInputHash({
    destinations: destinations.map(describeEgressDestination).toSorted(),
  });
}

/**
 * Runs a per-call gated tool only when its destinations are allowlisted or an approval covers this
 * exact input and exactly the destinations that still need approval. An approved continuation
 * reaches execution without a fresh authorization, so the destinations are decided again here: an
 * origin removed from the allowlist after the approval was never shown to the approver.
 */
export async function assertEgressAdmittedAtExecution(
  options: RuntimeToolBindingOptions,
  definition: ToolAdapterDefinition,
  request: RuntimeToolBindingRequest & { readonly decision: RuntimeToolAllowedDecision },
  gate: PerCallEgressGate,
): Promise<void> {
  const egress = await perCallEgressDecision(options, definition, request, gate);
  if (egress.action === "allow") return;
  const binding = request.decision.executionBinding;
  const approvedInput =
    egress.action === "require-approval" &&
    request.approvalId !== undefined &&
    request.policyAction === "require-approval" &&
    binding?.inputHash === runtimeToolInputHash(request.input ?? {}) &&
    binding.destinationsHash === egressDestinationsHash(egress.destinations);
  if (approvedInput) return;
  throw new RuntimeToolExecutionKnownFailureError(
    request.toolName,
    new Error(
      egressDenialMessage(
        request.toolName,
        gate,
        egress.action === "deny" ? egress.reason : "No approval covers this call's destinations.",
      ),
    ),
  );
}

/**
 * Resolves an active platform or extension tool adapter definition by name, refusing one whose
 * egress the organization's data boundary does not admit, unless each call's destinations can be
 * read from its input (then the result carries an `egressGate`). A failed boundary read throws a
 * retryable preparation error, so the call never proceeds on an unknown boundary.
 */
export function runtimeToolDefinitionLookup(options: RuntimeToolBindingOptions) {
  return async (
    toolName: string,
    context?: RuntimeTenantScope & AgentRunIdentity,
  ): Promise<RuntimeToolDefinitionLookupResult> => {
    const platformDefinition = findPlatformToolAdapterDefinition(toolName);
    const definition = platformDefinition
      ? options.isToolAvailable?.(toolName) === false
        ? undefined
        : platformDefinition
      : context
        ? await options.resolveExtensionToolDefinition?.(toolName, context)
        : undefined;
    if (!definition) return { kind: "missing" };
    const egress = toolEgress(definition);
    if (egressAdmittedByEveryProfile(egress)) return { definition, kind: "found" };
    // Without an organization the boundary cannot be read, so a restricted egress stays closed.
    if (!context) return { kind: "missing" };
    let boundary: DataBoundary;
    try {
      boundary = await options.dataBoundaries.read(context.organizationId);
    } catch (cause) {
      throw new RuntimeToolPreparationRetryableError(toolName, cause);
    }
    if (boundaryAdmitsEgress(boundary, egress)) return { definition, kind: "found" };
    return hasPerCallEgressDecision(definition)
      ? { definition, egressGate: { boundary }, kind: "found" }
      : { boundary, egress, kind: "outside-boundary", toolName };
  };
}

export type RuntimeToolDefinitionLookup = ReturnType<typeof runtimeToolDefinitionLookup>;

/** Authorizes a runtime tool call against its catalog execution plan and tool policy. */
export function createRuntimeToolCallAuthorizer(
  options: RuntimeToolBindingOptions,
  definitionFor: RuntimeToolDefinitionLookup,
): RuntimeToolService["authorizeToolCall"] {
  return async (request) => {
    const toolCallId = await options.generateId();
    const lookup = await definitionFor(request.toolName, request);
    if (lookup.kind === "outside-boundary") {
      return deny(toolOutsideDataBoundaryMessage(lookup), toolCallId);
    }
    const definition = lookup.kind === "found" ? lookup.definition : undefined;
    const egressGate = lookup.kind === "found" ? lookup.egressGate : undefined;
    const denial = toolCatalogDenial(
      request.toolName,
      toolCatalogStatus(request.toolName, definition),
    );
    if (denial || !definition) {
      return deny(denial ?? `Runtime tool ${request.toolName} is not registered.`, toolCallId);
    }
    let plan: RuntimeToolExecutionPlan;
    try {
      plan = executionPlan(definition, options.builtinExecutors);
    } catch (cause) {
      return deny(
        cause instanceof RuntimeToolPlanError
          ? cause.message
          : `Runtime tool ${request.toolName} execution plan is invalid.`,
        toolCallId,
      );
    }
    if (request.effect !== plan.effect) {
      return deny(
        `Runtime tool ${request.toolName} effect does not match its catalog.`,
        toolCallId,
      );
    }
    const requiredScopes = plan.requiredScopes;
    if (!sameScopes(requiredScopes, request.requiredScopes ?? [])) {
      return deny(`Runtime tool ${request.toolName} scopes do not match its catalog.`, toolCallId);
    }
    const mcpPlan = plan.kind === "mcp-read" || plan.kind === "mcp-mutation" ? plan : undefined;
    const resolveMcpContext = mcpPlan?.vendor
      ? options.executeVendorMcpTool && options.resolveVendorMcpAuthorizationContext
      : options.executeMcpTool && options.resolveMcpAuthorizationContext;
    if (mcpPlan && !resolveMcpContext) {
      return deny(`Runtime tool ${request.toolName} has no MCP execution binding.`, toolCallId);
    }
    /** Applies a per-call gated tool's egress decision after the policy decision. */
    const decided = async (
      decision: {
        readonly action: "allow" | "deny" | "require_approval";
        readonly reason: string;
      },
      executionBinding: RuntimeToolExecutionBinding,
    ): Promise<RuntimeToolDecision> => {
      if (decision.action === "deny") return deny(decision.reason, toolCallId);
      const egress = egressGate
        ? await perCallEgressDecision(options, definition, request, egressGate)
        : undefined;
      if (egress?.action === "deny") {
        return deny(egressDenialMessage(request.toolName, egressGate!, egress.reason), toolCallId);
      }
      if (egress?.action === "require-approval") {
        return {
          action: "require-approval",
          approvalId: await options.generateId(),
          destinations: egress.destinations.map(describeEgressDestination),
          executionBinding: {
            ...executionBinding,
            destinationsHash: egressDestinationsHash(egress.destinations),
            inputHash: runtimeToolInputHash(request.input ?? {}),
          },
          reason: `Tool ${request.toolName} would send data outside this organization's ${egressGate!.boundary.profile} data boundary to destinations its egress allowlist does not list, so a person must approve them.`,
          toolCallId,
        };
      }
      if (decision.action === "require_approval") {
        return {
          action: "require-approval",
          approvalId: await options.generateId(),
          executionBinding,
          reason: decision.reason,
          toolCallId,
        };
      }
      return { action: "allow", executionBinding, reason: decision.reason, toolCallId };
    };
    if (plan.kind === "builtin" || plan.kind === "hosted-code" || plan.kind === "client") {
      const executionBinding =
        plan.kind === "client" ? clientExecutionBinding(plan) : builtinExecutionBinding(plan);
      const catalog = decideToolPolicy(definition);
      if (catalog.action === "deny") return deny(catalog.reason, toolCallId);
      const decision =
        plan.kind === "builtin" && plan.executor.approval
          ? await plan.executor.approval(request)
          : catalog;
      return decided(decision, executionBinding);
    }
    const context = await (mcpPlan && resolveMcpContext
      ? resolveMcpContext(request, plan.adapter)
      : options.resolveAuthorizationContext(request, definition));
    if (!context) {
      return deny(
        `Runtime tool ${request.toolName} requires an active ${mcpPlan ? "MCP" : "provider"} connection.`,
        toolCallId,
      );
    }
    if (
      (plan.kind === "provider-read" || plan.kind === "provider-mutation") &&
      !acceptsProvider(plan.definition, context.connectorProvider)
    ) {
      return deny(
        `Runtime tool ${request.toolName} is not connected to an accepted provider.`,
        toolCallId,
      );
    }
    if (
      plan.kind === "http-callback" &&
      (!definition.provider ||
        canonicalProvider(definition.provider) !== canonicalProvider(context.connectorProvider))
    ) {
      return deny(
        `Runtime tool ${request.toolName} is not connected to its configured provider.`,
        toolCallId,
      );
    }
    const decision = decideToolPolicy(definition, {
      connectorProvider: context.connectorProvider,
      grantedScopes: context.grantedScopes,
      ...(context.policyRules === undefined ? {} : { policyRules: context.policyRules }),
    });
    const executionBinding = {
      authorizationFingerprint: context.authorizationFingerprint,
      connectionId: context.connectionId,
      externalAccountId: context.externalAccountId,
      ...(plan.kind === "http-callback"
        ? {
            inputHash: runtimeToolInputHash({
              ...request.input,
              ...context.externalResourceConstraints,
            }),
          }
        : {}),
      ...(definition.toolAdapterId ? { toolAdapterId: definition.toolAdapterId } : {}),
      toolPlanFingerprint: plan.fingerprint,
    };
    return decided(decision, executionBinding);
  };
}
