import { describe, expect, test } from "bun:test";
import {
  assembleRuntimeConfig,
  withToolBindings,
  type DeploymentConfig,
} from "./runtime-config.ts";
import { GRANT_A, GRANT_B, manifest, POLICY, ULID } from "./tool-bindings.fixture.ts";

const HELPER = ULID("D9");
const BASE: DeploymentConfig = {
  agentBindings: { helper: { agentDeploymentId: HELPER } },
  apiVersion: "agents.deployments.ai/v1",
  brainRetrievalMode: "hybrid",
  kind: "AgentDeploymentConfig",
  toolAuthorizations: {
    "crm.read": { authorizationId: GRANT_A, toolPolicyId: POLICY },
    "docs.search": { authorizationId: GRANT_A },
  },
};

describe("withToolBindings", () => {
  test("sets, replaces, and removes bindings and passes every other key through", () => {
    expect(
      withToolBindings(BASE, {
        "crm.read": { authorizationId: GRANT_B, toolPolicyId: POLICY },
        "docs.search": null,
        "mail.send": { authorizationId: GRANT_A },
      }),
    ).toEqual({
      agentBindings: { helper: { agentDeploymentId: HELPER } },
      apiVersion: "agents.deployments.ai/v1",
      brainRetrievalMode: "hybrid",
      kind: "AgentDeploymentConfig",
      toolAuthorizations: {
        "crm.read": { authorizationId: GRANT_B, toolPolicyId: POLICY },
        "mail.send": { authorizationId: GRANT_A },
      },
    });
  });

  test("starts from the default config and omits an emptied binding map", () => {
    expect(withToolBindings(undefined, { "crm.read": { authorizationId: GRANT_A } })).toEqual({
      apiVersion: "agents.deployments.ai/v1",
      kind: "AgentDeploymentConfig",
      toolAuthorizations: { "crm.read": { authorizationId: GRANT_A } },
    });
    expect(
      withToolBindings(
        { ...BASE, agentBindings: undefined },
        {
          "crm.read": null,
          "docs.search": null,
        },
      ),
    ).toEqual({
      agentBindings: undefined,
      apiVersion: "agents.deployments.ai/v1",
      brainRetrievalMode: "hybrid",
      kind: "AgentDeploymentConfig",
    });
  });

  test("leaves the input untouched", () => {
    const before = structuredClone(BASE);
    withToolBindings(BASE, { "crm.read": null });
    expect(BASE).toEqual(before);
  });
});

describe("assembleRuntimeConfig", () => {
  const helperAgent = [{ key: "helper", required: true }];

  test("reports nothing for a config every release accepts", () => {
    const release = manifest(
      [{ name: "crm.read", required: true }, { name: "docs.search" }],
      helperAgent,
    );
    expect(assembleRuntimeConfig({ base: BASE, changes: {}, manifests: [release] })).toEqual({
      config: BASE,
      dropped: [],
      issues: [],
    });
  });

  test("unbinding a required tool yields the platform's missing_tool_authorization issue", () => {
    const release = manifest(
      [{ name: "crm.read", required: true }, { name: "docs.search" }],
      helperAgent,
    );
    expect(
      assembleRuntimeConfig({
        base: BASE,
        changes: { "crm.read": null },
        manifests: [release],
      }).issues,
    ).toEqual([
      {
        code: "missing_tool_authorization",
        message: "Deployment configuration must bind workspace authorization for crm.read.",
        path: "/toolAuthorizations/crm.read",
      },
    ]);
  });

  test("an explicit binding the release does not declare yields undeclared_tool_authorization", () => {
    const release = manifest([{ name: "crm.read" }, { name: "docs.search" }], helperAgent);
    expect(
      assembleRuntimeConfig({
        base: BASE,
        changes: { "ghost/tool": { authorizationId: GRANT_A } },
        manifests: [release],
      }).issues,
    ).toEqual([
      {
        code: "undeclared_tool_authorization",
        message: "Deployment configuration binds undeclared tool capability ghost/tool.",
        path: "/toolAuthorizations/ghost~1tool",
      },
    ]);
  });

  test("drops base bindings a target release cannot accept and keeps the rest", () => {
    const primary = manifest([{ name: "crm.read" }, { name: "docs.search" }], helperAgent);
    const candidate = manifest(
      [{ name: "crm.read" }, { name: "docs.search", workspace: false }],
      helperAgent,
    );
    const assembled = assembleRuntimeConfig({
      base: BASE,
      changes: {},
      manifests: [primary, candidate],
    });
    expect(assembled.dropped).toEqual(["docs.search"]);
    expect(assembled.config.toolAuthorizations).toEqual({
      "crm.read": { authorizationId: GRANT_A, toolPolicyId: POLICY },
    });
    expect(assembled.issues).toEqual([]);
  });

  test("a tool required by the primary but not bindable in the candidate cannot be satisfied", () => {
    const primary = manifest([{ name: "crm.read", required: true }], helperAgent);
    const candidate = manifest([{ name: "crm.read", workspace: false }], helperAgent);
    const { issues } = assembleRuntimeConfig({
      base: BASE,
      changes: { "crm.read": { authorizationId: GRANT_A } },
      manifests: [primary, candidate],
    });
    expect(issues.map(({ code }) => code)).toEqual(["tool_authorization_not_allowed"]);
  });

  test("passes sub-agent issues through so a missing required binding is caught", () => {
    const release = manifest(
      [{ name: "crm.read" }, { name: "docs.search" }],
      [
        { key: "helper", required: true },
        { key: "writer", required: true },
      ],
    );
    expect(assembleRuntimeConfig({ base: BASE, changes: {}, manifests: [release] }).issues).toEqual(
      [
        {
          code: "missing_agent_binding",
          message: "Deployment configuration must bind required sub-agent writer.",
          path: "/agentBindings/writer",
        },
      ],
    );
  });
});
