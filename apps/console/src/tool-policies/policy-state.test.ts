import { AgentDeploymentResponse } from "@deployments-ai/api-contract/agents";
import { ToolPolicyResponse } from "@deployments-ai/api-contract/tooling";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  deploymentPins,
  parsePolicySearch,
  pinnedBy,
  policyPinning,
  policyActions,
  policyOptions,
  policyPage,
  type DeploymentPins,
} from "./policy-state.ts";

const P1 = "01K00000000000000000000P01";
const P2 = "01K00000000000000000000P02";
const G1 = "01K00000000000000000000G01";

function policy(id: string, name: string, status = "active") {
  return Schema.decodeUnknownSync(ToolPolicyResponse)({
    createdAt: "2026-10-01T00:00:00.000Z",
    id,
    name,
    policy: { rules: [] },
    status,
    updatedAt: "2026-10-01T00:00:00.000Z",
    version: 0,
  });
}

describe("policyPage", () => {
  const policies = [
    policy("01K00000000000000000000P03", "zeta"),
    policy("01K00000000000000000000P04", "Alpha", "archived"),
    policy("01K00000000000000000000P05", "beta"),
  ];

  test("the active view hides archived policies and counts them", () => {
    const page = policyPage(policies, { complete: true, offset: 0, pageSize: 25, view: "active" });
    expect(page.policies.map((entry) => entry.name)).toEqual(["beta", "zeta"]);
    expect(page.hidden).toBe(1);
    expect(page.nextOffset).toBeUndefined();
  });

  test("the all view lists active policies before archived ones, by name, a page at a time", () => {
    const first = policyPage(policies, { complete: false, offset: 0, pageSize: 2, view: "all" });
    expect({ ...first, policies: first.policies.map((entry) => entry.name) }).toEqual({
      complete: false,
      hidden: 0,
      nextOffset: 2,
      policies: ["beta", "zeta"],
    });
    const second = policyPage(policies, { complete: false, offset: 2, pageSize: 2, view: "all" });
    expect(second.policies.map((entry) => entry.name)).toEqual(["Alpha"]);
    expect(second.nextOffset).toBeUndefined();
  });

  test("the search keeps only the all view", () => {
    expect(parsePolicySearch({ show: "all" })).toEqual({ show: "all" });
    expect(parsePolicySearch({ show: "active" })).toEqual({});
  });

  test("simulator options list active policies by name and say when the walk was capped", () => {
    const options = policyOptions(policies, false);
    expect({
      ...options,
      items: options.items.map(({ id, name }) => `${name} ${id}`),
    }).toEqual({
      complete: false,
      items: ["beta 01K00000000000000000000P05", "zeta 01K00000000000000000000P03"],
    });
  });
});

test("an archived policy can only be duplicated", () => {
  expect(policyActions({ status: "active" })).toEqual(["edit", "duplicate", "archive"]);
  expect(policyActions({ status: "archived" })).toEqual(["duplicate"]);
});

describe("pins", () => {
  function deployment(id: string, desiredState: string, toolAuthorizations?: unknown) {
    return Schema.decodeUnknownSync(AgentDeploymentResponse)({
      agentDefinitionId: "01K00000000000000000000A01",
      agentReleaseId: "01K00000000000000000000R01",
      createdAt: "2026-10-01T00:00:00.000Z",
      currentState: desiredState === "stopped" ? "stopped" : "ready",
      desiredState,
      environmentId: "01K0000000000000000000000E",
      id,
      organizationId: "01K0000000000000000000000G",
      projectId: "01K0000000000000000000000P",
      ...(toolAuthorizations === undefined
        ? {}
        : {
            runtimeConfig: {
              apiVersion: "agents.deployments.ai/v1",
              kind: "AgentDeploymentConfig",
              toolAuthorizations,
            },
          }),
      updatedAt: "2026-10-01T00:00:00.000Z",
      version: 1,
    });
  }

  const names = new Map([["01K00000000000000000000A01", "Triage agent"]]);

  test("projects a deployment to the tools it pins to a policy, with its agent's name", () => {
    expect(
      deploymentPins(
        deployment("01K00000000000000000000D01", "running", {
          "github.issues.read": { authorizationId: G1, toolPolicyId: P1 },
          "slack.post": { authorizationId: G1 },
        }),
        names,
      ),
    ).toEqual({
      agentDefinitionId: "01K00000000000000000000A01",
      agentName: "Triage agent",
      deploymentId: "01K00000000000000000000D01",
      desiredState: "running",
      pins: [{ toolName: "github.issues.read", toolPolicyId: P1 }],
    });
    expect(deploymentPins(deployment("01K00000000000000000000D02", "paused"), new Map())).toEqual({
      agentDefinitionId: "01K00000000000000000000A01",
      deploymentId: "01K00000000000000000000D02",
      desiredState: "paused",
      pins: [],
    });
  });

  test("names the live deployments pinning a policy, with their tools", () => {
    const deployments: DeploymentPins[] = [
      deployment("01K00000000000000000000D01", "running", {
        "b.write": { authorizationId: G1, toolPolicyId: P1 },
        "a.read": { authorizationId: G1, toolPolicyId: P1 },
        "c.read": { authorizationId: G1, toolPolicyId: P2 },
      }),
      deployment("01K00000000000000000000D02", "stopped", {
        "a.read": { authorizationId: G1, toolPolicyId: P1 },
      }),
      deployment("01K00000000000000000000D03", "paused", {
        "c.read": { authorizationId: G1, toolPolicyId: P2 },
      }),
    ].map((entry) => deploymentPins(entry, names));
    expect(pinnedBy(P1, deployments)).toEqual([
      {
        agentDefinitionId: "01K00000000000000000000A01",
        agentName: "Triage agent",
        deploymentId: "01K00000000000000000000D01",
        tools: ["a.read", "b.write"],
      },
    ]);
    expect(pinnedBy(P2, deployments).map((entry) => entry.deploymentId)).toEqual([
      "01K00000000000000000000D01",
      "01K00000000000000000000D03",
    ]);
  });
});

describe("policyPinning", () => {
  const pins = (complete: boolean, toolPolicyId: string) => ({
    complete,
    deployments: [
      {
        agentDefinitionId: "01K00000000000000000000A01",
        deploymentId: "01K00000000000000000000D01",
        desiredState: "running" as const,
        pins: [{ toolName: "a.read", toolPolicyId }],
      },
    ],
  });

  test("a change reaches live deployments when one pins the policy", () => {
    expect(policyPinning(P1, pins(true, P1))).toEqual({
      atRisk: true,
      known: true,
      pinning: [
        {
          agentDefinitionId: "01K00000000000000000000A01",
          deploymentId: "01K00000000000000000000D01",
          tools: ["a.read"],
        },
      ],
    });
  });

  test("an unpinned policy is safe only when every deployment was read", () => {
    expect(policyPinning(P1, pins(true, P2))).toEqual({ atRisk: false, known: true, pinning: [] });
    expect(policyPinning(P1, pins(false, P2)).atRisk).toBe(true);
    expect(policyPinning(P1, undefined)).toEqual({ atRisk: true, known: false, pinning: [] });
  });
});
