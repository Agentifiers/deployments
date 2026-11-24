import {
  CreateToolPolicyRequest,
  type ToolPolicyResponse,
  type UpdateToolPolicyRequest,
} from "@deployments-ai/api-contract/tooling";
import { Schema, SchemaIssue } from "effect";

export const ACTIONS = ["allow", "deny", "require_approval"] as const;
export type Action = (typeof ACTIONS)[number];
export const EFFECTS = ["execute", "read", "write"] as const;
export type Effect = (typeof EFFECTS)[number];

export interface ConditionValues {
  readonly toolName: string;
  readonly toolPrefix: string;
  readonly effect: readonly Effect[];
  readonly connectorProvider: string;
  readonly providerKey: string;
  readonly requiredScopes: readonly string[];
}
export type ConditionField = keyof ConditionValues;
export type Condition = {
  readonly [Field in ConditionField]: {
    readonly field: Field;
    readonly value: ConditionValues[Field];
  };
}[ConditionField];
export type RuleConditions = Partial<ConditionValues>;

export const CONDITION_FIELDS = [
  "toolName",
  "toolPrefix",
  "effect",
  "connectorProvider",
  "providerKey",
  "requiredScopes",
] as const satisfies readonly ConditionField[];

export interface RuleDraft {
  readonly key: string;
  readonly action: Action;
  readonly conditions: RuleConditions;
  readonly reason: string;
}

export type DefaultAction = Action | "tool_default";

export interface PolicyDraft {
  readonly name: string;
  readonly description: string;
  readonly defaultAction: DefaultAction;
  readonly defaultReason: string;
  readonly rules: readonly RuleDraft[];
  readonly nextRuleKey: number;
}

export type EditorCommand =
  | { readonly type: "add"; readonly after?: string }
  | { readonly type: "remove"; readonly key: string }
  | { readonly type: "move"; readonly key: string; readonly to: number }
  | { readonly type: "setAction"; readonly key: string; readonly action: Action }
  | { readonly type: "setCondition"; readonly key: string; readonly condition: Condition }
  | { readonly type: "clearCondition"; readonly key: string; readonly field: ConditionField }
  | { readonly type: "setReason"; readonly key: string; readonly reason: string }
  | { readonly type: "setDefault"; readonly action: DefaultAction; readonly reason: string }
  | { readonly type: "setMeta"; readonly name?: string; readonly description?: string };

export type CreatePolicyRequest = typeof CreateToolPolicyRequest.Type;
export type UpdatePolicyRequest = CreatePolicyRequest &
  Pick<typeof UpdateToolPolicyRequest.Type, "expectedVersion">;
type PolicyView = typeof ToolPolicyResponse.Type;
type PolicyRule = CreatePolicyRequest["policy"]["rules"][number];

export const EMPTY_DRAFT: PolicyDraft = {
  defaultAction: "tool_default",
  defaultReason: "",
  description: "",
  name: "",
  nextRuleKey: 0,
  rules: [],
};

const NEW_RULE_ACTION: Action = "require_approval";
const MAX_NAME_LENGTH = 120;

function updateRule(
  draft: PolicyDraft,
  key: string,
  change: (rule: RuleDraft) => RuleDraft,
): PolicyDraft {
  return { ...draft, rules: draft.rules.map((rule) => (rule.key === key ? change(rule) : rule)) };
}

export function policyEditor(draft: PolicyDraft, command: EditorCommand): PolicyDraft {
  switch (command.type) {
    case "add": {
      const rule: RuleDraft = {
        action: NEW_RULE_ACTION,
        conditions: {},
        key: `r${draft.nextRuleKey}`,
        reason: "",
      };
      const after = draft.rules.findIndex((existing) => existing.key === command.after);
      const at = after === -1 ? draft.rules.length : after + 1;
      return {
        ...draft,
        nextRuleKey: draft.nextRuleKey + 1,
        rules: draft.rules.toSpliced(at, 0, rule),
      };
    }
    case "remove":
      return { ...draft, rules: draft.rules.filter((rule) => rule.key !== command.key) };
    case "move": {
      const from = draft.rules.findIndex((rule) => rule.key === command.key);
      const rule = draft.rules[from];
      if (rule === undefined) return draft;
      const to = Math.min(Math.max(command.to, 0), draft.rules.length - 1);
      return { ...draft, rules: draft.rules.toSpliced(from, 1).toSpliced(to, 0, rule) };
    }
    case "setAction":
      return updateRule(draft, command.key, (rule) => ({ ...rule, action: command.action }));
    case "setCondition":
      return updateRule(draft, command.key, (rule) => ({
        ...rule,
        conditions: { ...rule.conditions, [command.condition.field]: command.condition.value },
      }));
    case "clearCondition":
      return updateRule(draft, command.key, (rule) => {
        const { [command.field]: _cleared, ...conditions } = rule.conditions;
        return { ...rule, conditions };
      });
    case "setReason":
      return updateRule(draft, command.key, (rule) => ({ ...rule, reason: command.reason }));
    case "setDefault":
      return { ...draft, defaultAction: command.action, defaultReason: command.reason };
    case "setMeta":
      return {
        ...draft,
        ...(command.name === undefined ? {} : { name: command.name }),
        ...(command.description === undefined ? {} : { description: command.description }),
      };
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
}

function ruleConditions(rule: PolicyRule): RuleConditions {
  const { connectorProvider, effect, providerKey, requiredScopes, toolName, toolPrefix } = rule;
  return {
    ...(toolName === undefined ? {} : { toolName }),
    ...(toolPrefix === undefined ? {} : { toolPrefix }),
    ...(effect === undefined ? {} : { effect: typeof effect === "string" ? [effect] : effect }),
    ...(connectorProvider === undefined ? {} : { connectorProvider }),
    ...(providerKey === undefined ? {} : { providerKey }),
    ...(requiredScopes === undefined ? {} : { requiredScopes }),
  };
}

export function fromPolicy(
  policy: Pick<PolicyView, "description" | "name" | "policy">,
): PolicyDraft {
  const { rules } = policy.policy;
  return {
    defaultAction: policy.policy.defaultAction ?? "tool_default",
    defaultReason: policy.policy.defaultReason ?? "",
    description: policy.description ?? "",
    name: policy.name,
    nextRuleKey: rules.length,
    rules: rules.map((rule, index) => ({
      action: rule.action,
      conditions: ruleConditions(rule),
      key: `r${index}`,
      reason: rule.reason ?? "",
    })),
  };
}

export function duplicateDraft(
  policy: Pick<PolicyView, "description" | "name" | "policy">,
): PolicyDraft {
  return { ...fromPolicy(policy), name: `Copy of ${policy.name}`.slice(0, MAX_NAME_LENGTH) };
}

function candidateRule({ action, conditions, reason }: RuleDraft) {
  const { effect, requiredScopes, ...text } = conditions;
  return {
    action,
    ...Object.fromEntries(Object.entries(text).map(([field, value]) => [field, value.trim()])),
    ...(effect === undefined ? {} : { effect: effect.length === 1 ? effect[0] : effect }),
    ...(requiredScopes === undefined
      ? {}
      : { requiredScopes: requiredScopes.map((scope) => scope.trim()) }),
    ...(reason.trim() === "" ? {} : { reason: reason.trim() }),
  };
}

function candidateRequest(draft: PolicyDraft) {
  const description = draft.description.trim();
  const defaultReason = draft.defaultReason.trim();
  return {
    name: draft.name.trim(),
    ...(description === "" ? {} : { description }),
    policy: {
      ...(draft.defaultAction === "tool_default" ? {} : { defaultAction: draft.defaultAction }),
      ...(defaultReason === "" ? {} : { defaultReason }),
      rules: draft.rules.map(candidateRule),
    },
  };
}

export type IssueField =
  | ConditionField
  | "action"
  | "defaultReason"
  | "description"
  | "name"
  | "policy"
  | "reason";

export interface DraftIssue {
  readonly field: IssueField;
  readonly message: string;
  readonly ruleKey?: string;
}

export type DraftResult<Request = CreatePolicyRequest> =
  | { readonly ok: true; readonly request: Request }
  | { readonly ok: false; readonly issues: readonly DraftIssue[] };

const PROVIDER_KEY_MESSAGE =
  "Use a provider key: lowercase letters, numbers, dots, underscores, or hyphens, such as github.";
const TEXT_MESSAGE = "Enter text of at most 4,096 characters.";

const ISSUE_MESSAGES: Readonly<Record<IssueField, string>> = {
  action: "Choose allow, deny, or require approval.",
  connectorProvider: PROVIDER_KEY_MESSAGE,
  defaultReason: TEXT_MESSAGE,
  description: "A saved description can be changed but not removed.",
  effect: "Choose execute, read, or write.",
  name: `Enter a name of at most ${MAX_NAME_LENGTH} characters.`,
  providerKey: PROVIDER_KEY_MESSAGE,
  reason: TEXT_MESSAGE,
  policy: "The policy does not match the API contract.",
  requiredScopes: "Enter scopes of at most 4,096 characters each.",
  toolName:
    "Use letters, numbers, dots, underscores, slashes, or hyphens, with a letter or number at each end.",
  toolPrefix: TEXT_MESSAGE,
};

function isIssueField(value: unknown): value is IssueField {
  return typeof value === "string" && Object.hasOwn(ISSUE_MESSAGES, value);
}

const issueList = SchemaIssue.makeFormatterStandardSchemaV1();
const decodeRequest = Schema.decodeUnknownSync(CreateToolPolicyRequest);

function draftIssue(draft: PolicyDraft, path: readonly unknown[]): DraftIssue {
  const [head, section, index, field] = path;
  if (head === "name") return { field: "name", message: ISSUE_MESSAGES.name };
  if (head === "policy" && section === "defaultReason") {
    return { field: "defaultReason", message: ISSUE_MESSAGES.defaultReason };
  }
  const rule = section === "rules" && typeof index === "number" ? draft.rules[index] : undefined;
  if (head !== "policy" || rule === undefined || !isIssueField(field)) {
    return { field: "policy", message: ISSUE_MESSAGES.policy };
  }
  return { field, message: ISSUE_MESSAGES[field], ruleKey: rule.key };
}

export function toRequest(draft: PolicyDraft): DraftResult {
  try {
    return { ok: true, request: decodeRequest(candidateRequest(draft), { errors: "all" }) };
  } catch (cause) {
    if (!Schema.isSchemaError(cause)) throw cause;
    const issues = new Map<string, DraftIssue>();
    for (const { path } of issueList(cause.issue).issues) {
      const issue = draftIssue(draft, path ?? []);
      issues.set(`${issue.ruleKey ?? ""}:${issue.field}`, issue);
    }
    return { issues: [...issues.values()], ok: false };
  }
}

/** The API keeps the stored description when the field is absent and rejects a blank one. */
export function toUpdateRequest(
  draft: PolicyDraft,
  base: Pick<PolicyView, "description" | "version">,
): DraftResult<UpdatePolicyRequest> {
  const result = toRequest(draft);
  const removesDescription = Boolean(base.description) && draft.description.trim() === "";
  const issues = [
    ...(result.ok ? [] : result.issues),
    ...(removesDescription
      ? [{ field: "description", message: ISSUE_MESSAGES.description } as const]
      : []),
  ];
  if (!result.ok || removesDescription) return { issues, ok: false };
  return { ok: true, request: { ...result.request, expectedVersion: base.version } };
}

export function conditionList(conditions: RuleConditions): readonly Condition[] {
  const { connectorProvider, effect, providerKey, requiredScopes, toolName, toolPrefix } =
    conditions;
  return [
    ...(toolName === undefined ? [] : [{ field: "toolName", value: toolName } as const]),
    ...(toolPrefix === undefined ? [] : [{ field: "toolPrefix", value: toolPrefix } as const]),
    ...(effect === undefined ? [] : [{ field: "effect", value: effect } as const]),
    ...(connectorProvider === undefined
      ? []
      : [{ field: "connectorProvider", value: connectorProvider } as const]),
    ...(providerKey === undefined ? [] : [{ field: "providerKey", value: providerKey } as const]),
    ...(requiredScopes === undefined
      ? []
      : [{ field: "requiredScopes", value: requiredScopes } as const]),
  ];
}

export type RuleFinding =
  | { readonly kind: "never_matches" }
  | { readonly kind: "shadowed"; readonly by: number };

const trimmed = (value: string | undefined) => value?.trim();

function covers(earlier: RuleConditions, later: RuleConditions): boolean {
  const name = trimmed(earlier.toolName);
  if (name !== undefined && trimmed(later.toolName) !== name) return false;
  const prefix = trimmed(earlier.toolPrefix);
  if (
    prefix !== undefined &&
    ![later.toolName, later.toolPrefix].some((value) => trimmed(value)?.startsWith(prefix))
  ) {
    return false;
  }
  const effects = earlier.effect ?? EFFECTS;
  if (!(later.effect ?? EFFECTS).every((effect) => effects.includes(effect))) return false;
  const connector = trimmed(earlier.connectorProvider);
  if (connector !== undefined && trimmed(later.connectorProvider) !== connector) return false;
  const provider = trimmed(earlier.providerKey);
  if (
    provider !== undefined &&
    ![later.providerKey, later.connectorProvider].some((value) => trimmed(value) === provider)
  ) {
    return false;
  }
  const scopes = new Set(later.requiredScopes?.map((scope) => scope.trim()));
  return (earlier.requiredScopes ?? []).every((scope) => scopes.has(scope.trim()));
}

export function ruleFindings(draft: PolicyDraft): ReadonlyMap<string, RuleFinding> {
  const findings = new Map<string, RuleFinding>();
  draft.rules.forEach((rule, index) => {
    if (rule.conditions.effect?.length === 0) {
      findings.set(rule.key, { kind: "never_matches" });
      return;
    }
    const by = draft.rules
      .slice(0, index)
      .findIndex((earlier) => covers(earlier.conditions, rule.conditions));
    if (by !== -1) findings.set(rule.key, { by, kind: "shadowed" });
  });
  return findings;
}

export const ACTION_LABELS: Readonly<Record<Action, string>> = {
  allow: "allow",
  deny: "deny",
  require_approval: "require approval",
};

const list = (values: readonly string[], conjunction: string) =>
  values.length <= 1
    ? (values[0] ?? "")
    : `${values.slice(0, -1).join(", ")} ${conjunction} ${values.at(-1)}`;

const CONDITION_PHRASES: {
  readonly [Field in ConditionField]: (value: ConditionValues[Field]) => string;
} = {
  connectorProvider: (value) => `connector provider is ${value}`,
  effect: (value) => `effect is ${value.length === 0 ? "none" : list(value, "or")}`,
  providerKey: (value) => `provider is ${value}`,
  requiredScopes: (value) => `granted scopes include ${list(value, "and")}`,
  toolName: (value) => `tool name is ${value}`,
  toolPrefix: (value) => `tool name starts with ${value}`,
};

function conditionPhrase<Field extends ConditionField>(
  field: Field,
  value: ConditionValues[Field],
): string {
  return CONDITION_PHRASES[field](value);
}

export function describeRule(rule: Pick<RuleDraft, "action" | "conditions">): string {
  const phrases = CONDITION_FIELDS.flatMap((field) => {
    const value = rule.conditions[field];
    return value === undefined ? [] : [conditionPhrase(field, value)];
  });
  const when = phrases.length === 0 ? "Every tool" : `When ${phrases.join(" and ")}`;
  return `${when} → ${ACTION_LABELS[rule.action]}`;
}
