import { ToolPolicyEvaluation } from "@deployments-ai/api-contract/tool-catalog";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  bindingModel,
  grantProblem,
  parseBindingChanges,
  previewGroups,
  rowPreview,
  saveCause,
  type BindingWorkbench,
  type GrantOption,
  type WorkspaceTool,
} from "./tool-bindings.ts";
import { GRANT_A, GRANT_B, POLICY, ULID } from "./tool-bindings.fixture.ts";

const SERVER = ULID("S1");
const MCP_CONNECTION = ULID("C1");
const GRANT_MCP = ULID("GM");
const GRANT_REVOKED = ULID("GR");
const POLICY_ARCHIVED = ULID("P9");

function grant(id: string, fields: Partial<GrantOption> = {}): GrantOption {
  return {
    connectionId: ULID("C9"),
    externalAccountId: "acct",
    id,
    providerKey: "hubspot",
    purpose: "agent-runtime",
    scopes: ["crm.read"],
    status: "active",
    workspaceId: ULID("W1"),
    ...fields,
  };
}

const CRM: WorkspaceTool = {
  bindableIn: ["primary"],
  defaultPolicyAction: "allow",
  name: "crm.read",
  requiredIn: ["primary"],
  requiredScopes: ["crm.read"],
  route: { kind: "provider", providerKey: "hubspot" },
};
const ECHO: WorkspaceTool = {
  bindableIn: ["primary"],
  defaultPolicyAction: "allow",
  name: "echo",
  requiredIn: [],
  requiredScopes: ["echo"],
  route: { kind: "mcp", mcpServerId: SERVER },
};
const NOTES: WorkspaceTool = {
  bindableIn: ["primary"],
  name: "notes.write",
  requiredIn: [],
  requiredScopes: [],
  route: { kind: "catalog" },
};

function workbench(fields: Partial<BindingWorkbench> = {}): BindingWorkbench {
  return {
    base: {},
    grants: [
      grant(GRANT_A),
      grant(GRANT_B, { providerKey: "salesforce" }),
      grant(GRANT_MCP, {
        connectionId: MCP_CONNECTION,
        externalAccountId: SERVER,
        providerKey: "mcp",
        scopes: ["echo"],
      }),
      grant(GRANT_REVOKED, { status: "revoked" }),
    ],
    mcpConnections: { complete: true, items: [{ active: true, id: MCP_CONNECTION }] },
    policies: { complete: true, items: [{ id: POLICY, name: "Default" }] },
    preflight: [],
    target: { kind: "new", releaseId: ULID("R1") },
    tools: [CRM, ECHO, NOTES],
    ...fields,
  };
}

describe("grantProblem", () => {
  const bench = workbench();
  const find = (id: string) => bench.grants.find((option) => option.id === id);

  test("a provider tool fits only an active agent-runtime grant of its provider with its scopes", () => {
    expect(grantProblem(CRM, find(GRANT_A), bench)).toBe(undefined);
    expect(grantProblem(CRM, find(GRANT_B), bench)).toEqual({
      expected: "hubspot",
      kind: "wrong_provider",
    });
    expect(grantProblem(CRM, find(GRANT_REVOKED), bench)).toEqual({
      kind: "revoked",
    });
    expect(grantProblem(CRM, undefined, bench)).toEqual({ kind: "missing" });
    expect(grantProblem(CRM, grant(GRANT_A, { purpose: "sync" }), bench)).toEqual({
      kind: "wrong_purpose",
    });
    expect(grantProblem(CRM, grant(GRANT_A, { scopes: [] }), bench)).toEqual({
      kind: "missing_scopes",
      scopes: ["crm.read"],
    });
  });

  test("an MCP tool needs a grant on its server through an active MCP connection", () => {
    expect(grantProblem(ECHO, find(GRANT_MCP), bench)).toBe(undefined);
    expect(grantProblem(ECHO, find(GRANT_A), bench)).toEqual({
      expected: SERVER,
      kind: "wrong_server",
    });
    expect(
      grantProblem(ECHO, find(GRANT_MCP), {
        mcpConnections: { complete: true, items: [{ active: false, id: MCP_CONNECTION }] },
      }),
    ).toEqual({ kind: "mcp_connection_inactive" });
  });

  test("a connection missing from a complete MCP directory is inactive; past the cap it is the API's call", () => {
    expect(
      grantProblem(ECHO, find(GRANT_MCP), { mcpConnections: { complete: true, items: [] } }),
    ).toEqual({ kind: "mcp_connection_inactive" });
    expect(
      grantProblem(ECHO, find(GRANT_MCP), { mcpConnections: { complete: false, items: [] } }),
    ).toBe(undefined);
    expect(
      grantProblem(ECHO, find(GRANT_MCP), {
        mcpConnections: { complete: false, items: [{ active: false, id: MCP_CONNECTION }] },
      }),
    ).toEqual({ kind: "mcp_connection_inactive" });
  });
});

describe("bindingModel", () => {
  test("lists eligible grants per route and blocks an unbound required tool", () => {
    const model = bindingModel(workbench(), {});
    expect(
      model.rows.map(({ eligible, status, tool }) => [
        tool.name,
        status.kind,
        eligible.map(({ id }) => id),
      ]),
    ).toEqual([
      ["crm.read", "needs_grant", [GRANT_A]],
      ["echo", "optional_unbound", [GRANT_MCP]],
      ["notes.write", "optional_unbound", [GRANT_A, GRANT_B, GRANT_MCP]],
    ]);
    expect(model.submittable).toBe(false);
  });

  test("binding the required tool makes a deploy submittable and sends only that change", () => {
    const model = bindingModel(workbench(), {
      "crm.read": { authorizationId: GRANT_A, toolPolicyId: POLICY },
    });
    expect(model.rows[0]?.status).toEqual({ kind: "ready" });
    expect(model.changes).toEqual({
      "crm.read": { authorizationId: GRANT_A, toolPolicyId: POLICY },
    });
    expect(model.submittable).toBe(true);
  });

  test("flags unusable grants, archived policies, and ignored catalog bindings without blocking", () => {
    const model = bindingModel(workbench(), {
      "crm.read": { authorizationId: GRANT_B },
      echo: { authorizationId: GRANT_MCP, toolPolicyId: POLICY_ARCHIVED },
      "notes.write": { authorizationId: GRANT_A },
    });
    expect(model.rows.map(({ status }) => status)).toEqual([
      {
        kind: "grant_unusable",
        problem: { expected: "hubspot", kind: "wrong_provider" },
      },
      { kind: "policy_unusable" },
      { kind: "binding_ignored" },
    ]);
    expect(model.submittable).toBe(true);
  });

  test("a policy missing from a capped policy list is not called archived", () => {
    const model = bindingModel(workbench({ policies: { complete: false, items: [] } }), {
      "crm.read": { authorizationId: GRANT_A, toolPolicyId: POLICY_ARCHIVED },
    });
    expect(model.rows[0]?.status).toEqual({ kind: "ready" });
  });

  test("an edit with no change is not submittable, and unbinding is a null change", () => {
    const existing = workbench({
      base: {
        "crm.read": { authorizationId: GRANT_A },
        echo: { authorizationId: GRANT_MCP },
      },
      target: {
        deploymentId: ULID("D1"),
        desiredState: "paused",
        kind: "existing",
        primaryReleaseId: ULID("R1"),
        version: 3,
      },
    });
    expect(bindingModel(existing, {}).submittable).toBe(false);
    expect(bindingModel(existing, { "crm.read": { authorizationId: GRANT_A } }).submittable).toBe(
      false,
    );
    const unbound = bindingModel(existing, { echo: null });
    expect(unbound.changes).toEqual({ echo: null });
    expect(unbound.submittable).toBe(true);
  });

  test("during a canary a tool must be bindable in both releases", () => {
    const canary = workbench({
      base: {
        echo: { authorizationId: GRANT_MCP },
        legacy: { authorizationId: GRANT_A },
      },
      target: {
        candidateReleaseId: ULID("R2"),
        deploymentId: ULID("D1"),
        desiredState: "running",
        kind: "existing",
        primaryReleaseId: ULID("R1"),
        version: 3,
      },
      tools: [
        { ...CRM, bindableIn: ["primary"], requiredIn: ["primary"] },
        { ...ECHO, bindableIn: ["primary"] },
      ],
    });
    const model = bindingModel(canary, {
      echo: { authorizationId: GRANT_MCP, toolPolicyId: POLICY },
    });
    expect(model.rows.map(({ status }) => status.kind)).toEqual([
      "canary_conflict",
      "not_bindable_in_canary",
    ]);
    expect(model.dropped).toEqual(["echo", "legacy"]);
    expect(model.changes).toEqual({});
    expect(model.submittable).toBe(false);
  });

  test("choices rebase onto a reloaded base after a conflict", () => {
    const choices = {
      "crm.read": { authorizationId: GRANT_A },
      echo: { authorizationId: GRANT_MCP },
    };
    const stale = workbench({ base: {} });
    expect(Object.keys(bindingModel(stale, choices).changes)).toEqual(["crm.read", "echo"]);
    const fresh = workbench({ base: { echo: { authorizationId: GRANT_MCP } } });
    const rebased = bindingModel(fresh, choices);
    expect(rebased.changes).toEqual({
      "crm.read": { authorizationId: GRANT_A },
    });
    expect(rebased.rows[1]?.before).toEqual({ authorizationId: GRANT_MCP });
  });
});

describe("previewGroups and rowPreview", () => {
  test("groups bound connection tools per policy in chunks of 100", () => {
    const tools = Array.from({ length: 101 }, (_, index) => ({
      ...CRM,
      name: `crm.t${String(index).padStart(3, "0")}`,
      requiredIn: [],
    }));
    const choices = Object.fromEntries(
      tools.map(({ name }) => [name, { authorizationId: GRANT_A, toolPolicyId: POLICY }]),
    );
    const model = bindingModel(workbench({ tools: [...tools, NOTES] }), {
      ...choices,
      "notes.write": { authorizationId: GRANT_A, toolPolicyId: POLICY },
    });
    const groups = previewGroups(model);
    expect(groups.map(({ toolNames, toolPolicyId }) => [toolPolicyId, toolNames.length])).toEqual([
      [POLICY, 100],
      [POLICY, 1],
    ]);
    expect(groups[1]?.toolNames).toEqual(["crm.t100"]);
  });

  test("previews the policy result, the tool default, or why none applies", () => {
    const model = bindingModel(workbench(), {
      "crm.read": { authorizationId: GRANT_A, toolPolicyId: POLICY },
      echo: { authorizationId: GRANT_MCP },
    });
    const evaluation = Schema.decodeUnknownSync(ToolPolicyEvaluation)({
      action: "deny",
      basis: "rule",
      catalogStatus: "active",
      matchedRuleIndex: 0,
      policyApplies: true,
      reason: "No CRM reads.",
      toolName: "crm.read",
      toolPolicyId: POLICY,
    });
    const evaluations = new Map([[`${POLICY} crm.read`, evaluation]]);
    const pending = new Map<string, typeof evaluation>();
    const [crm, echo, notes] = model.rows;
    expect(crm && rowPreview(crm, evaluations)).toEqual({
      evaluation,
      kind: "policy",
      toolPolicyId: POLICY,
    });
    expect(crm && rowPreview(crm, pending)).toEqual({ kind: "pending" });
    expect(echo && rowPreview(echo, evaluations)).toEqual({
      action: "allow",
      kind: "tool_default",
    });
    expect(notes && rowPreview(notes, evaluations)).toEqual({
      kind: "not_applicable",
      why: "unbound",
    });
  });
});

describe("parseBindingChanges", () => {
  test("accepts bindings and null removals keyed by tool name", () => {
    expect(
      parseBindingChanges({
        "crm.read": { authorizationId: GRANT_A },
        echo: null,
      }),
    ).toEqual({
      "crm.read": { authorizationId: GRANT_A },
      echo: null,
    });
  });

  test("rejects a malformed grant ID, a bad tool name, and more than 256 tools", () => {
    expect(() => parseBindingChanges({ "crm.read": { authorizationId: "grant" } })).toThrow();
    expect(() => parseBindingChanges({ "bad name": null })).toThrow();
    expect(() =>
      parseBindingChanges(
        Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`t${index}`, null])),
      ),
    ).toThrow("changes must name at most 256 tools.");
  });
});

describe("saveCause", () => {
  const problem = (code: string, detail: string) => ({ code, detail, status: 422, title: "T" });
  const policyRefusal = problem(
    "model_not_allowed_by_environment_policy",
    "/spec/model/id: Model openrouter/default is not allowed.",
  );

  test("a model policy refusal names re-admission and the remedy the action allows", () => {
    expect(saveCause(policyRefusal, "save")).toBe(
      "Deploying, resuming, or saving bindings on a running deployment re-admits the release's models. Change the model policy or pause the deployment, then save again.",
    );
    expect(saveCause(policyRefusal, "deploy")).toBe(
      "Deploying, resuming, or saving bindings on a running deployment re-admits the release's models. A new deployment is admitted even when paused, so change the model policy, then deploy again.",
    );
    expect(saveCause(problem("model_not_in_catalog", "/spec/model/id: Unknown."), "deploy")).toBe(
      "Deploying, resuming, or saving bindings on a running deployment re-admits the release's models. Publish a release whose models are active in the catalog.",
    );
    expect(saveCause(problem("invalid_model_id", "/spec/model/id: Invalid."), "save")).toBe(
      "Deploying, resuming, or saving bindings on a running deployment re-admits the release's models. Publish a release whose model IDs are valid.",
    );
    expect(saveCause(problem("unknown_model_provider", "/spec/model/id: Prefix."), "deploy")).toBe(
      "Deploying, resuming, or saving bindings on a running deployment re-admits the release's models. Publish a release whose model IDs start with a known provider prefix.",
    );
  });

  test("a key reused for a different request sends the operator to the deployments", () => {
    const reused = { code: "idempotency_conflict", status: 409, title: "Reused" };
    expect(saveCause(reused, "deploy")).toBe("Check the deployments before trying again.");
    expect(saveCause(reused, "save")).toBe("Check the deployments before trying again.");
  });

  test("explains sub-agent and tool binding refusals; other problems need nothing", () => {
    expect(
      saveCause(
        problem(
          "invalid_agent_deployment_config",
          "/toolAuthorizations/a: one\n/agentBindings/helper: Bound agent deployment is stopped.",
        ),
        "save",
      ),
    ).toBe(
      "Every save re-resolves the deployment's sub-agent bindings, and one no longer resolves. Rebind the sub-agent by updating the deployment's runtime configuration through the API, then save again.",
    );
    expect(
      saveCause(
        problem(
          "invalid_agent_deployment_config",
          "/toolAuthorizations/a: one\n/toolAuthorizations/b: two",
        ),
        "save",
      ),
    ).toBe("The release does not accept these tool bindings.");
    expect(saveCause({ code: "version_conflict", status: 409, title: "Changed" }, "save")).toBe(
      undefined,
    );
  });
});
