import { ToolPolicyResponse } from "@deployments-ai/api-contract/tooling";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  describeRule,
  duplicateDraft,
  EMPTY_DRAFT,
  fromPolicy,
  policyEditor,
  ruleFindings,
  toRequest,
  toUpdateRequest,
  type EditorCommand,
  type PolicyDraft,
} from "./rules-editor.ts";

function policy(document: unknown, description?: string) {
  return Schema.decodeUnknownSync(ToolPolicyResponse)({
    createdAt: "2026-10-01T00:00:00.000Z",
    ...(description === undefined ? {} : { description }),
    id: "01K00000000000000000000P01",
    name: "Production guard",
    policy: document,
    status: "active",
    updatedAt: "2026-10-01T00:00:00.000Z",
    version: 3,
  });
}

function edit(draft: PolicyDraft, ...commands: readonly EditorCommand[]): PolicyDraft {
  return commands.reduce(policyEditor, draft);
}

const named = edit(EMPTY_DRAFT, { name: "Guard", type: "setMeta" });

const EVERY_FIELD = {
  defaultAction: "deny",
  defaultReason: "Only listed tools run here.",
  rules: [
    { action: "allow", toolName: "github.issues.read" },
    { action: "require_approval", toolPrefix: "github." },
    { action: "allow", effect: "read" },
    { action: "deny", effect: ["execute", "write"], reason: "No side effects." },
    { action: "allow", connectorProvider: "mcp" },
    { action: "allow", providerKey: "slack" },
    { action: "require_approval", requiredScopes: ["repo", "admin:org"] },
    {
      action: "deny",
      connectorProvider: "github",
      effect: "write",
      providerKey: "github",
      reason: "Pinned by name and prefix.",
      requiredScopes: ["repo"],
      toolName: "github.repos.delete",
      toolPrefix: "github.repos.",
    },
    { action: "allow", effect: [] },
    { action: "deny", requiredScopes: [] },
  ],
} as const;

describe("round trip", () => {
  test("every rule field combination comes back as the same request", () => {
    const source = policy(EVERY_FIELD, "Guards production tools.");
    const result = toRequest(fromPolicy(source));
    expect(result).toEqual({
      ok: true,
      request: {
        description: "Guards production tools.",
        name: "Production guard",
        policy: EVERY_FIELD,
      },
    });
  });

  test("a policy without a default keeps each tool's own default", () => {
    const draft = fromPolicy(policy({ rules: [] }));
    expect(draft.defaultAction).toBe("tool_default");
    expect(toRequest(draft)).toEqual({
      ok: true,
      request: { name: "Production guard", policy: { rules: [] } },
    });
  });

  test("a one-element effect list reads back as the single effect the runtime treats alike", () => {
    const draft = fromPolicy(policy({ rules: [{ action: "deny", effect: ["write"] }] }));
    expect(toRequest(draft)).toEqual({
      ok: true,
      request: {
        name: "Production guard",
        policy: { rules: [{ action: "deny", effect: "write" }] },
      },
    });
  });

  test("a duplicate copies the rules under a new name", () => {
    const copy = duplicateDraft(policy(EVERY_FIELD));
    expect(copy.name).toBe("Copy of Production guard");
    expect(toRequest(copy)).toEqual({
      ok: true,
      request: { name: "Copy of Production guard", policy: EVERY_FIELD },
    });
  });
});

describe("policyEditor", () => {
  test("adds rules with fresh keys at the end or after a given rule", () => {
    const draft = edit(named, { type: "add" }, { type: "add" }, { after: "r0", type: "add" });
    expect(draft.rules.map((rule) => rule.key)).toEqual(["r0", "r2", "r1"]);
    expect(draft.nextRuleKey).toBe(3);
  });

  test("moves, removes, and edits rules by key", () => {
    const draft = edit(
      named,
      { type: "add" },
      { type: "add" },
      { type: "add" },
      { key: "r0", type: "setAction", action: "allow" },
      { condition: { field: "toolPrefix", value: " github. " }, key: "r0", type: "setCondition" },
      { condition: { field: "effect", value: ["write"] }, key: "r0", type: "setCondition" },
      { field: "effect", key: "r0", type: "clearCondition" },
      { key: "r1", reason: "Blocked.", type: "setReason" },
      { key: "r2", to: 0, type: "move" },
      { key: "r1", type: "remove" },
      { action: "deny", reason: "Closed by default.", type: "setDefault" },
    );
    expect(toRequest(draft)).toEqual({
      ok: true,
      request: {
        name: "Guard",
        policy: {
          defaultAction: "deny",
          defaultReason: "Closed by default.",
          rules: [{ action: "require_approval" }, { action: "allow", toolPrefix: "github." }],
        },
      },
    });
  });

  test("a move past either end clamps to the list", () => {
    const draft = edit(named, { type: "add" }, { type: "add" }, { key: "r0", to: 9, type: "move" });
    expect(draft.rules.map((rule) => rule.key)).toEqual(["r1", "r0"]);
  });
});

describe("toRequest issues", () => {
  test("maps each contract issue to its rule and field", () => {
    const draft = edit(
      EMPTY_DRAFT,
      { type: "add" },
      { type: "add" },
      { condition: { field: "toolName", value: "bad name!" }, key: "r0", type: "setCondition" },
      { condition: { field: "providerKey", value: "GitHub" }, key: "r1", type: "setCondition" },
      { condition: { field: "toolPrefix", value: "  " }, key: "r1", type: "setCondition" },
    );
    expect(toRequest(draft)).toEqual({
      issues: [
        { field: "name", message: "Enter a name of at most 120 characters." },
        {
          field: "toolName",
          message:
            "Use letters, numbers, dots, underscores, slashes, or hyphens, with a letter or number at each end.",
          ruleKey: "r0",
        },
        {
          field: "providerKey",
          message:
            "Use a provider key: lowercase letters, numbers, dots, underscores, or hyphens, such as github.",
          ruleKey: "r1",
        },
        { field: "toolPrefix", message: "Enter text of at most 4,096 characters.", ruleKey: "r1" },
      ],
      ok: false,
    });
  });

  test("an issue names the rule by key, not by its position, after a move", () => {
    const draft = edit(
      named,
      { type: "add" },
      { type: "add" },
      { condition: { field: "connectorProvider", value: "Bad" }, key: "r1", type: "setCondition" },
      { key: "r1", to: 0, type: "move" },
    );
    const result = toRequest(draft);
    expect(
      result.ok ? [] : result.issues.map(({ field, ruleKey }) => ({ field, ruleKey })),
    ).toEqual([{ field: "connectorProvider", ruleKey: "r1" }]);
  });
});

describe("toUpdateRequest", () => {
  test("a policy saved without a description saves without one", () => {
    const source = policy({ rules: [] });
    expect(toUpdateRequest(fromPolicy(source), source)).toEqual({
      ok: true,
      request: { expectedVersion: 3, name: "Production guard", policy: { rules: [] } },
    });
  });

  test("a changed description is sent with the version the edit started from", () => {
    const source = policy({ rules: [] }, "Guards production tools.");
    const draft = edit(fromPolicy(source), { description: " Guards staging. ", type: "setMeta" });
    expect(toUpdateRequest(draft, source)).toEqual({
      ok: true,
      request: {
        description: "Guards staging.",
        expectedVersion: 3,
        name: "Production guard",
        policy: { rules: [] },
      },
    });
  });

  test("clearing a saved description is an issue, because the API keeps the old one", () => {
    const source = policy({ rules: [] }, "Guards production tools.");
    const draft = edit(fromPolicy(source), { description: "  ", type: "setMeta" });
    expect(toUpdateRequest(draft, source)).toEqual({
      issues: [
        { field: "description", message: "A saved description can be changed but not removed." },
      ],
      ok: false,
    });
  });
});

describe("ruleFindings", () => {
  const rules = (...documentRules: readonly unknown[]) =>
    ruleFindings(fromPolicy(policy({ rules: documentRules })));

  test("a rule with no conditions shadows every rule after it", () => {
    expect(
      rules({ action: "deny" }, { action: "allow", toolName: "a" }, { action: "allow" }),
    ).toEqual(
      new Map([
        ["r1", { by: 0, kind: "shadowed" }],
        ["r2", { by: 0, kind: "shadowed" }],
      ]),
    );
  });

  test("a prefix shadows a longer prefix and a tool name under it", () => {
    expect(
      rules(
        { action: "deny", toolPrefix: "github." },
        { action: "allow", toolPrefix: "github.repos." },
        { action: "allow", toolName: "github.issues.read" },
        { action: "allow", toolName: "slack.post" },
        { action: "allow", toolName: "x.read", toolPrefix: "github." },
      ),
    ).toEqual(
      new Map([
        ["r1", { by: 0, kind: "shadowed" }],
        ["r2", { by: 0, kind: "shadowed" }],
        ["r4", { by: 0, kind: "shadowed" }],
      ]),
    );
  });

  test("an exact tool name does not shadow a prefix", () => {
    expect(
      rules(
        { action: "deny", toolName: "github.read" },
        { action: "allow", toolPrefix: "github." },
      ),
    ).toEqual(new Map());
  });

  test("effects shadow only a subset of themselves", () => {
    expect(
      rules(
        { action: "deny", effect: ["read", "write"] },
        { action: "allow", effect: "write" },
        { action: "allow", effect: ["write", "execute"] },
        { action: "allow" },
      ),
    ).toEqual(new Map([["r1", { by: 0, kind: "shadowed" }]]));
  });

  test("required scopes shadow rules that require a superset", () => {
    expect(
      rules(
        { action: "deny", requiredScopes: ["repo"] },
        { action: "allow", requiredScopes: ["repo", "admin:org"] },
        { action: "allow", requiredScopes: ["admin:org"] },
      ),
    ).toEqual(new Map([["r1", { by: 0, kind: "shadowed" }]]));
  });

  test("providers shadow by exact key, and a provider key covers the same connector provider", () => {
    expect(
      rules(
        { action: "deny", providerKey: "github" },
        { action: "allow", providerKey: "github", toolPrefix: "github." },
        { action: "allow", connectorProvider: "github" },
        { action: "allow", providerKey: "slack" },
        { action: "deny", connectorProvider: "mcp" },
        { action: "allow", providerKey: "mcp" },
      ),
    ).toEqual(
      new Map([
        ["r1", { by: 0, kind: "shadowed" }],
        ["r2", { by: 0, kind: "shadowed" }],
      ]),
    );
  });

  test("an empty effect list never matches and shadows nothing", () => {
    expect(rules({ action: "deny", effect: [] }, { action: "allow", effect: "read" })).toEqual(
      new Map([["r0", { kind: "never_matches" }]]),
    );
  });

  test("names the first shadowing rule", () => {
    expect(
      rules(
        { action: "allow", toolName: "a" },
        { action: "deny", toolPrefix: "a" },
        { action: "deny", toolName: "a" },
      ),
    ).toEqual(new Map([["r2", { by: 0, kind: "shadowed" }]]));
  });
});

describe("describeRule", () => {
  test("reads the conditions in field order", () => {
    const [rule] = fromPolicy(
      policy({
        rules: [
          {
            action: "require_approval",
            effect: ["read", "write", "execute"],
            requiredScopes: ["repo", "workflow"],
            toolPrefix: "github.",
          },
        ],
      }),
    ).rules;
    expect(rule && describeRule(rule)).toBe(
      "When tool name starts with github. and effect is read, write or execute and granted scopes include repo and workflow → require approval",
    );
  });

  test("a rule without conditions applies to every tool", () => {
    expect(describeRule({ action: "deny", conditions: {} })).toBe("Every tool → deny");
  });
});
