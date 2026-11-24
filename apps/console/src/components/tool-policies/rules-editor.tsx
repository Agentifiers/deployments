import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  Delete02Icon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import type { Dispatch } from "react";
import { oneOf } from "../../observability/range.ts";
import {
  ACTION_LABELS,
  ACTIONS,
  EFFECTS,
  CONDITION_FIELDS,
  conditionList,
  describeRule,
  type Condition,
  type ConditionField,
  type DraftIssue,
  type EditorCommand,
  type IssueField,
  type PolicyDraft,
  type RuleDraft,
  type RuleFinding,
} from "../../tool-policies/rules-editor.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  CheckboxField,
  Description,
  ErrorMessage,
  Field,
  FieldGroup,
  Label,
} from "@/components/ui/field";
import { Subheading } from "@/components/ui/heading";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Text } from "@/components/ui/text";
import { Textarea } from "@/components/ui/textarea";
import { Icon } from "../icon.tsx";

const FIELD_LABELS: Readonly<Record<ConditionField, string>> = {
  connectorProvider: "Connector provider",
  effect: "Effect",
  providerKey: "Provider",
  requiredScopes: "Granted scopes",
  toolName: "Tool name",
  toolPrefix: "Tool name prefix",
};

const FIELD_HINTS: Readonly<Record<ConditionField, string>> = {
  connectorProvider: "Exact connector provider, such as mcp for custom MCP tools.",
  effect: "Matches any checked effect.",
  providerKey: "Provider key; the runtime also matches its aliases.",
  requiredScopes: "Matches when the connection grants every scope. Separate with spaces or commas.",
  toolName: "Exact tool name.",
  toolPrefix: "Matches every tool name that starts with this text.",
};

const NEW_CONDITIONS: { readonly [Field in ConditionField]: Extract<Condition, { field: Field }> } =
  {
    connectorProvider: { field: "connectorProvider", value: "" },
    effect: { field: "effect", value: ["write"] },
    providerKey: { field: "providerKey", value: "" },
    requiredScopes: { field: "requiredScopes", value: [] },
    toolName: { field: "toolName", value: "" },
    toolPrefix: { field: "toolPrefix", value: "" },
  };

const DEFAULT_LABELS = { ...ACTION_LABELS, tool_default: "each tool's own default" } as const;

function issueMessage(
  issues: readonly DraftIssue[],
  ruleKey: string | undefined,
  field: IssueField,
): string | undefined {
  return issues.find((issue) => issue.ruleKey === ruleKey && issue.field === field)?.message;
}

function FindingBadge({ finding }: Readonly<{ finding: RuleFinding | undefined }>) {
  if (finding === undefined) return null;
  return (
    <Badge color="amber">
      {finding.kind === "never_matches"
        ? "Never matches: no effect is checked"
        : `Unreachable: rule ${finding.by + 1} matches first`}
    </Badge>
  );
}

function ConditionControl({
  condition,
  invalid,
  onChange,
  ruleKey,
}: Readonly<{
  condition: Condition;
  invalid: boolean;
  onChange: (condition: Condition) => void;
  ruleKey: string;
}>) {
  switch (condition.field) {
    case "effect":
      return (
        <div className="flex flex-wrap gap-x-6 gap-y-3 *:w-auto">
          {EFFECTS.map((effect) => (
            <CheckboxField key={effect}>
              <Checkbox
                checked={condition.value.includes(effect)}
                onCheckedChange={(checked) =>
                  onChange({
                    field: "effect",
                    value: EFFECTS.filter((entry) =>
                      entry === effect ? checked : condition.value.includes(entry),
                    ),
                  })
                }
              />
              <Label>{effect}</Label>
            </CheckboxField>
          ))}
        </div>
      );
    case "requiredScopes":
      return (
        <Input
          aria-label={FIELD_LABELS.requiredScopes}
          autoComplete="off"
          className="font-mono"
          defaultValue={condition.value.join(" ")}
          aria-invalid={invalid}
          key={`${ruleKey}:requiredScopes`}
          onChange={(event) =>
            onChange({
              field: "requiredScopes",
              value: event.target.value.split(/[\s,]+/u).filter((scope) => scope !== ""),
            })
          }
          placeholder="repo workflow"
        />
      );
    default:
      return (
        <Input
          aria-label={FIELD_LABELS[condition.field]}
          autoComplete="off"
          className="font-mono"
          aria-invalid={invalid}
          onChange={(event) => onChange({ field: condition.field, value: event.target.value })}
          value={condition.value}
        />
      );
  }
}

function RuleCard({
  count,
  dispatch,
  finding,
  index,
  issues,
  rule,
}: Readonly<{
  count: number;
  dispatch: Dispatch<EditorCommand>;
  finding: RuleFinding | undefined;
  index: number;
  issues: readonly DraftIssue[];
  rule: RuleDraft;
}>) {
  const present = conditionList(rule.conditions);
  const absent = CONDITION_FIELDS.filter((field) => rule.conditions[field] === undefined);
  const reasonIssue = issueMessage(issues, rule.key, "reason");
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          Rule {index + 1}
          <FindingBadge finding={finding} />
          <span className="ml-auto flex gap-1">
            <Button
              aria-label={`Move rule ${index + 1} up`}
              disabled={index === 0}
              onClick={() => dispatch({ key: rule.key, to: index - 1, type: "move" })}
              variant="ghost"
            >
              <Icon icon={ArrowUp01Icon} />
            </Button>
            <Button
              aria-label={`Move rule ${index + 1} down`}
              disabled={index === count - 1}
              onClick={() => dispatch({ key: rule.key, to: index + 1, type: "move" })}
              variant="ghost"
            >
              <Icon icon={ArrowDown01Icon} />
            </Button>
            <Button
              aria-label={`Remove rule ${index + 1}`}
              onClick={() => dispatch({ key: rule.key, type: "remove" })}
              variant="ghost"
            >
              <Icon icon={Delete02Icon} />
            </Button>
          </span>
        </CardTitle>
        <Text>{describeRule(rule)}</Text>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <Field>
            <Label>Action</Label>
            <NativeSelect
              onChange={(event) => {
                const action = oneOf(ACTIONS, event.target.value);
                if (action) dispatch({ action, key: rule.key, type: "setAction" });
              }}
              value={rule.action}
            >
              {ACTIONS.map((action) => (
                <option key={action} value={action}>
                  {ACTION_LABELS[action]}
                </option>
              ))}
            </NativeSelect>
          </Field>
          {present.map((condition) => {
            const message = issueMessage(issues, rule.key, condition.field);
            return (
              <Field key={condition.field}>
                <div className="flex items-center gap-2">
                  <Label>{FIELD_LABELS[condition.field]}</Label>
                  <Button
                    aria-label={`Remove the ${FIELD_LABELS[condition.field].toLowerCase()} condition`}
                    className="ml-auto"
                    onClick={() =>
                      dispatch({ field: condition.field, key: rule.key, type: "clearCondition" })
                    }
                    variant="ghost"
                  >
                    <Icon icon={Delete02Icon} />
                  </Button>
                </div>
                <Description>{FIELD_HINTS[condition.field]}</Description>
                <ConditionControl
                  condition={condition}
                  invalid={message !== undefined}
                  onChange={(next) =>
                    dispatch({ condition: next, key: rule.key, type: "setCondition" })
                  }
                  ruleKey={rule.key}
                />
                {message ? <ErrorMessage>{message}</ErrorMessage> : null}
              </Field>
            );
          })}
          {absent.length > 0 ? (
            <Field>
              <Label>Add a condition</Label>
              <Description>
                {present.length === 0
                  ? "Without conditions, this rule matches every tool."
                  : "A tool must meet every condition."}
              </Description>
              <NativeSelect
                onChange={(event) => {
                  const field = oneOf(CONDITION_FIELDS, event.target.value);
                  if (field) {
                    dispatch({
                      condition: NEW_CONDITIONS[field],
                      key: rule.key,
                      type: "setCondition",
                    });
                  }
                }}
                value=""
              >
                <option disabled value="">
                  Choose a condition
                </option>
                {absent.map((field) => (
                  <option key={field} value={field}>
                    {FIELD_LABELS[field]}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          ) : null}
          <Field>
            <Label>Reason</Label>
            <Description>Shown with the decision. Empty uses the platform's reason.</Description>
            <Input
              autoComplete="off"
              aria-invalid={reasonIssue !== undefined}
              onChange={(event) =>
                dispatch({ key: rule.key, reason: event.target.value, type: "setReason" })
              }
              value={rule.reason}
            />
            {reasonIssue ? <ErrorMessage>{reasonIssue}</ErrorMessage> : null}
          </Field>
        </FieldGroup>
      </CardContent>
    </Card>
  );
}

export function PolicyFields({
  dispatch,
  draft,
  findings,
  issues,
}: Readonly<{
  dispatch: Dispatch<EditorCommand>;
  draft: PolicyDraft;
  findings: ReadonlyMap<string, RuleFinding>;
  issues: readonly DraftIssue[];
}>) {
  const nameIssue = issueMessage(issues, undefined, "name");
  const defaultReasonIssue = issueMessage(issues, undefined, "defaultReason");
  const descriptionIssue = issueMessage(issues, undefined, "description");
  return (
    <div className="flex flex-col gap-8">
      <FieldGroup>
        <Field>
          <Label>Name</Label>
          <Description>Required.</Description>
          <Input
            autoComplete="off"
            aria-invalid={nameIssue !== undefined && draft.name !== ""}
            required
            onChange={(event) => dispatch({ name: event.target.value, type: "setMeta" })}
            value={draft.name}
          />
          {nameIssue && draft.name !== "" ? <ErrorMessage>{nameIssue}</ErrorMessage> : null}
        </Field>
        <Field>
          <Label>Description</Label>
          <Textarea
            aria-invalid={descriptionIssue !== undefined}
            onChange={(event) => dispatch({ description: event.target.value, type: "setMeta" })}
            rows={2}
            value={draft.description}
          />
          {descriptionIssue ? <ErrorMessage>{descriptionIssue}</ErrorMessage> : null}
        </Field>
      </FieldGroup>
      <section className="flex flex-col gap-4">
        <Subheading>Rules</Subheading>
        <Text>
          The runtime checks rules from top to bottom and the first match decides. Rules apply to
          connection tools: provider, MCP, and HTTP callback tools. Platform, hosted code, and
          client tools keep their own default.
        </Text>
        {draft.rules.map((rule, index) => (
          <RuleCard
            count={draft.rules.length}
            dispatch={dispatch}
            finding={findings.get(rule.key)}
            index={index}
            issues={issues}
            key={rule.key}
            rule={rule}
          />
        ))}
        <div>
          <Button onClick={() => dispatch({ type: "add" })} variant="outline">
            <Icon icon={PlusSignIcon} />
            Add rule
          </Button>
        </div>
      </section>
      <section className="flex flex-col gap-4">
        <Subheading>When no rule matches</Subheading>
        <FieldGroup>
          <Field>
            <Label>Default action</Label>
            <NativeSelect
              onChange={(event) => {
                const action = oneOf(["tool_default", ...ACTIONS] as const, event.target.value);
                if (action) dispatch({ action, reason: draft.defaultReason, type: "setDefault" });
              }}
              value={draft.defaultAction}
            >
              {(["tool_default", ...ACTIONS] as const).map((action) => (
                <option key={action} value={action}>
                  {DEFAULT_LABELS[action]}
                </option>
              ))}
            </NativeSelect>
          </Field>
          {draft.defaultAction === "tool_default" ? null : (
            <Field>
              <Label>Default reason</Label>
              <Input
                autoComplete="off"
                aria-invalid={defaultReasonIssue !== undefined}
                onChange={(event) =>
                  dispatch({
                    action: draft.defaultAction,
                    reason: event.target.value,
                    type: "setDefault",
                  })
                }
                value={draft.defaultReason}
              />
              {defaultReasonIssue ? <ErrorMessage>{defaultReasonIssue}</ErrorMessage> : null}
            </Field>
          )}
        </FieldGroup>
      </section>
    </div>
  );
}
