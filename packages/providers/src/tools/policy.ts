export const TOOL_EFFECTS = ["read", "write", "execute"] as const;
export const TOOL_POLICY_ACTIONS = ["allow", "require_approval", "deny"] as const;
export type ToolEffect = (typeof TOOL_EFFECTS)[number];
export type ToolPolicyAction = (typeof TOOL_POLICY_ACTIONS)[number];

export interface ToolPolicyRequest {
  readonly connectorProvider?: string;
  readonly effect: ToolEffect;
  readonly grantedScopes?: readonly string[];
  readonly requiredScopes?: readonly string[];
  readonly toolName: string;
}

export type ToolPolicyDecisionBasis = "default" | "required_scopes" | "rule";

export interface ToolPolicyDecision {
  readonly action: ToolPolicyAction;
  /** Whether the first matching rule, the policy default, or missing connector scopes decided. */
  readonly basis: ToolPolicyDecisionBasis;
  /** Index into the policy `rules` array of the matching rule when `basis` is `rule`. */
  readonly matchedRuleIndex?: number;
  readonly reason: string;
}

interface ToolPolicyRule {
  readonly action?: unknown;
  readonly connectorProvider?: unknown;
  readonly effect?: unknown;
  readonly providerKey?: unknown;
  readonly reason?: unknown;
  readonly requiredScopes?: unknown;
  readonly toolName?: unknown;
  readonly toolPrefix?: unknown;
}

interface ToolPolicyRules {
  readonly defaultAction?: unknown;
  readonly defaultReason?: unknown;
  readonly rules?: unknown;
}

const DEFAULT_REASONS: Record<ToolPolicyAction, string> = {
  allow: "Tool call is allowed by policy.",
  require_approval: "Tool call requires approval by policy.",
  deny: "Tool call is denied by policy.",
};

function isToolPolicyAction(value: unknown): value is ToolPolicyAction {
  return typeof value === "string" && TOOL_POLICY_ACTIONS.includes(value as ToolPolicyAction);
}

function isToolEffect(value: unknown): value is ToolEffect {
  return typeof value === "string" && TOOL_EFFECTS.includes(value as ToolEffect);
}

function asRules(value: unknown): ToolPolicyRules | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as ToolPolicyRules;
}

function asRule(value: unknown): ToolPolicyRule | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as ToolPolicyRule;
}

function effectMatches(ruleEffect: unknown, requestEffect: ToolEffect): boolean {
  if (ruleEffect === undefined) return true;
  if (isToolEffect(ruleEffect)) return ruleEffect === requestEffect;
  if (Array.isArray(ruleEffect)) {
    return ruleEffect.some((effect) => isToolEffect(effect) && effect === requestEffect);
  }

  return false;
}

function requiredScopes(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((scope): scope is string => typeof scope === "string" && scope.length > 0);
}

function providerKeyMatches(ruleProvider: string, connectorProvider: string | undefined): boolean {
  if (!connectorProvider) return false;
  const registry = codeProviderDefinitionRegistry();
  const canonicalRule = registry.resolve(ruleProvider)?.key;
  const canonicalConnector = registry.resolve(connectorProvider)?.key;
  if (canonicalRule !== undefined || canonicalConnector !== undefined) {
    return canonicalRule !== undefined && canonicalRule === canonicalConnector;
  }
  return ruleProvider.trim().toLowerCase() === connectorProvider.trim().toLowerCase();
}

export function hasRequiredScopes(args: {
  readonly grantedScopes?: readonly string[] | undefined;
  readonly requiredScopes?: readonly string[] | undefined;
}): boolean {
  const granted = new Set(args.grantedScopes ?? []);
  return (args.requiredScopes ?? []).every((scope) => granted.has(scope));
}

function ruleMatches(rule: ToolPolicyRule, request: ToolPolicyRequest): boolean {
  if (typeof rule.toolName === "string" && rule.toolName !== request.toolName) return false;
  if (typeof rule.toolPrefix === "string" && !request.toolName.startsWith(rule.toolPrefix)) {
    return false;
  }
  if (!effectMatches(rule.effect, request.effect)) return false;
  if (
    typeof rule.connectorProvider === "string" &&
    rule.connectorProvider !== request.connectorProvider
  ) {
    return false;
  }
  if (
    typeof rule.providerKey === "string" &&
    !providerKeyMatches(rule.providerKey, request.connectorProvider)
  ) {
    return false;
  }

  const scopes = requiredScopes(rule.requiredScopes);
  if (
    scopes.length > 0 &&
    !hasRequiredScopes({ grantedScopes: request.grantedScopes, requiredScopes: scopes })
  ) {
    return false;
  }

  return true;
}

function defaultDecision(effect: ToolEffect): ToolPolicyDecision {
  if (effect === "read") {
    return { action: "allow", basis: "default", reason: DEFAULT_REASONS.allow };
  }

  return {
    action: "require_approval",
    basis: "default",
    reason: "Side-effecting tool calls require approval by default.",
  };
}

export function evaluateToolPolicy(
  policyRules: unknown,
  request: ToolPolicyRequest,
): ToolPolicyDecision {
  if (
    !hasRequiredScopes({
      grantedScopes: request.grantedScopes,
      requiredScopes: request.requiredScopes,
    })
  ) {
    return {
      action: "deny",
      basis: "required_scopes",
      reason: "Required connector scopes have not been granted.",
    };
  }
  const rules = asRules(policyRules);
  if (!rules) return defaultDecision(request.effect);

  const ruleList = Array.isArray(rules.rules) ? rules.rules : [];
  for (const [matchedRuleIndex, rawRule] of ruleList.entries()) {
    const rule = asRule(rawRule);
    if (!rule || !isToolPolicyAction(rule.action)) continue;
    if (!ruleMatches(rule, request)) continue;
    return {
      action: rule.action,
      basis: "rule",
      matchedRuleIndex,
      reason:
        typeof rule.reason === "string" && rule.reason.trim()
          ? rule.reason.trim()
          : DEFAULT_REASONS[rule.action],
    };
  }

  const defaultAction = isToolPolicyAction(rules.defaultAction) ? rules.defaultAction : undefined;
  if (defaultAction) {
    return {
      action: defaultAction,
      basis: "default",
      reason:
        typeof rules.defaultReason === "string" && rules.defaultReason.trim()
          ? rules.defaultReason.trim()
          : DEFAULT_REASONS[defaultAction],
    };
  }

  return defaultDecision(request.effect);
}
import { codeProviderDefinitionRegistry } from "../provider-registry.ts";
