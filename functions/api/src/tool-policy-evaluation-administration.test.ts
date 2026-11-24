import { describe, expect, test } from "bun:test";
import { EvaluateToolPolicyResponse } from "@deployments-ai/api-contract";
import {
  AgentDeploymentRecord,
  ToolPolicyRecord,
  WorkspaceConnectionAuthorizationRecord,
  tableForItemType,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import {
  decideToolPolicy,
  findPlatformToolAdapterDefinition,
  makeToolAdapterRecord,
  toolAdapterDefinitionFromRecord,
  type ToolPolicyConnection,
} from "@deployments-ai/tools";
import { Schema } from "effect";
import {
  makeAdministrationPersistence,
  type AdministrationCredentialPort,
  type AdministrationInvocation,
} from "./administration-persistence.ts";

const ids = Array.from(
  { length: 20 },
  (_, index) => `01ARZ3NDEKTSV4RRFFQ69G5F${String(index).padStart(2, "0")}`,
) as Ulid[];
const [organizationId, projectId, environmentId, workspaceId] = ids as [Ulid, Ulid, Ulid, Ulid];
const releaseId = ids[4]!;
const deploymentId = ids[5]!;
const policyId = ids[6]!;
const archivedPolicyId = ids[7]!;
const authorizationId = ids[8]!;
const narrowAuthorizationId = ids[9]!;
const extensionId = ids[10]!;
const timestamp = "2026-07-23T12:00:00.000Z";
const tenancy = { environmentId, organizationId, projectId };

const rules = {
  defaultAction: "deny",
  rules: [
    { action: "deny", toolName: "shopify.orders.search" },
    { action: "require_approval", toolPrefix: "shopify.customers." },
    { action: "allow", effect: "read", providerKey: "shopify" },
  ],
};

function policy(id: Ulid, status: "active" | "archived") {
  return Schema.decodeUnknownSync(ToolPolicyRecord)(
    withCanonicalRecordKeys({
      data: {
        ...tenancy,
        createdAt: timestamp,
        id,
        name: `Policy ${id}`,
        rules,
        status,
        updatedAt: timestamp,
        version: 0,
      },
      itemType: "tool-policy" as const,
    }),
  );
}

function authorization(id: Ulid, scopes: readonly string[]) {
  return Schema.decodeUnknownSync(WorkspaceConnectionAuthorizationRecord)(
    withCanonicalRecordKeys({
      data: {
        ...tenancy,
        authorizationVersion: 1,
        connectionId: ids[11]!,
        createdAt: timestamp,
        externalAccountId: "shop-1",
        externalResourceConstraints: {},
        id,
        providerKey: "shopify",
        purpose: "agent-runtime",
        resourceScopeHash: "scope-hash",
        scopes: [...scopes],
        status: "active" as const,
        updatedAt: timestamp,
        version: 1,
        workspaceId,
      },
      itemType: "workspace-connection-authorization" as const,
    }),
  );
}

function deploymentRecords(): PlatformRecord[] {
  const tools = [
    { authorization: "workspace", name: "shopify.products.search", required: true },
    { authorization: "workspace", name: "shopify.customers.search", required: true },
    { authorization: "workspace", name: "shopify.orders.search", required: true },
    { authorization: "workspace", name: "shopify.inventory_levels.list", required: true },
    { name: "artifact.inspect", required: true },
  ];
  const manifest = {
    apiVersion: "agents.deployments.ai/v1",
    kind: "Agent",
    metadata: { key: "policy.evaluation", name: "Policy Evaluation", version: "1.0.0" },
    spec: {
      capabilities: { tools },
      instructions: "Use the tools.",
      model: { id: "openrouter/test" },
      sandbox: { mode: "none" },
    },
  };
  // Stored releases decode against their manifest hash; the evaluator reads only the manifest.
  const release = withCanonicalRecordKeys({
    data: {
      ...tenancy,
      agentDefinitionId: ids[12]!,
      contentHash: `sha256:${"a".repeat(64)}`,
      createdAt: timestamp,
      createdByPrincipalId: ids[13]!,
      id: releaseId,
      manifest,
      releaseNumber: 1,
      status: "active" as const,
      version: 0,
    },
    itemType: "agent-release" as const,
  } as unknown as PlatformRecord) as PlatformRecord;
  const deployment = Schema.decodeUnknownSync(AgentDeploymentRecord)(
    withCanonicalRecordKeys({
      data: {
        ...tenancy,
        agentDefinitionId: ids[12]!,
        agentReleaseId: releaseId,
        createdAt: timestamp,
        currentState: "ready" as const,
        desiredState: "running" as const,
        id: deploymentId,
        runtimeConfig: {
          apiVersion: "agents.deployments.ai/v1",
          kind: "AgentDeploymentConfig",
          toolAuthorizations: {
            "shopify.customers.search": { authorizationId, toolPolicyId: policyId },
            "shopify.orders.search": { authorizationId, toolPolicyId: archivedPolicyId },
            "shopify.products.search": {
              authorizationId: narrowAuthorizationId,
              toolPolicyId: policyId,
            },
          },
        },
        updatedAt: timestamp,
        version: 0,
      },
      itemType: "agent-deployment" as const,
    }),
  );
  return [release, deployment];
}

function service(seed: readonly PlatformRecord[]) {
  const records = new Map(
    seed.map((item) => [
      `${tableForItemType(item.itemType)}\u0000${item.pk}\u0000${item.sk}`,
      item,
    ]),
  );
  const database: DynamoDatabaseService = {
    deleteRecord: async () => {
      throw new Error("read-only");
    },
    getRecord: async (table, key) => records.get(`${table}\u0000${key.pk}\u0000${key.sk}`),
    putRecord: async () => {
      throw new Error("read-only");
    },
    queryRecords: async (table, input) => {
      const values = input.ExpressionAttributeValues as Record<string, unknown>;
      return {
        items: [...records.values()].filter(
          (record) =>
            tableForItemType(record.itemType) === table &&
            record.pk === values[":partition"] &&
            record.sk.startsWith(String(values[":prefix"])),
        ),
      };
    },
    transactWrite: async () => {
      throw new Error("read-only");
    },
  };
  return makeAdministrationPersistence({
    credentials: {} as AdministrationCredentialPort,
    database,
    mcpDiscovery: { discover: async () => [] },
    providerVerification: { verify: async () => ({ metadata: {}, scopes: [] }) },
    resolveEnvironment: async () => ({
      id: environmentId,
      organizationId,
      projectId,
      status: "active",
    }),
    resolveWorkspace: async () => true,
  });
}

function invocation(body: unknown): AdministrationInvocation {
  return {
    body,
    identity: {
      environmentIds: [environmentId],
      organizationIds: [organizationId],
      principalId: ids[14]!,
      projectIds: [projectId],
      scopes: ["tools:read"],
    },
    params: {},
    query: {},
    scope: { environmentId },
  };
}

async function evaluate(seed: readonly PlatformRecord[], body: unknown) {
  return Schema.decodeUnknownSync(EvaluateToolPolicyResponse)(
    await service(seed).invoke("evaluateToolPolicy", invocation(body)),
  );
}

function runtimeDecision(toolName: string, connection?: ToolPolicyConnection) {
  const decision = decideToolPolicy(findPlatformToolAdapterDefinition(toolName)!, connection);
  return {
    action: decision.action,
    basis: decision.basis,
    matchedRuleIndex: decision.matchedRuleIndex ?? null,
    reason: decision.reason,
  };
}

const archivedTool = "bitbucket.issues.list";
const clientExtension = makeToolAdapterRecord({
  definition: {
    defaultPolicyAction: "require_approval",
    description: "Client confirmation",
    effect: "write",
    execution: { type: "client" },
    inputSchema: { type: "object" },
    toolName: "custom.confirm",
  },
  ...tenancy,
  id: extensionId,
  occurredAt: timestamp,
});

describe("tool policy evaluation", () => {
  test("decides a policy for each tool exactly as runtime enforcement does", async () => {
    const response = await evaluate([policy(policyId, "active"), clientExtension], {
      toolNames: [
        "shopify.orders.search",
        "shopify.customers.search",
        "shopify.products.search",
        "shopify.inventory.adjust",
        "artifact.inspect",
        "custom.confirm",
        archivedTool,
        "custom.unknown",
      ],
      toolPolicyId: policyId,
    });
    const connection = (toolName: string): ToolPolicyConnection => ({
      connectorProvider: "shopify",
      grantedScopes: findPlatformToolAdapterDefinition(toolName)!.requiredScopes ?? [],
      policyRules: rules,
    });
    const byName = Object.fromEntries(response.results.map((result) => [result.toolName, result]));
    for (const [toolName, expected] of [
      ["shopify.orders.search", { action: "deny", basis: "rule", matchedRuleIndex: 0 }],
      ["shopify.customers.search", { action: "require_approval", matchedRuleIndex: 1 }],
      ["shopify.products.search", { action: "allow", basis: "rule", matchedRuleIndex: 2 }],
      ["shopify.inventory.adjust", { action: "deny", basis: "default", matchedRuleIndex: null }],
    ] as const) {
      expect(byName[toolName]).toMatchObject({
        ...runtimeDecision(toolName, connection(toolName)),
        ...expected,
        catalogStatus: "active",
        policyApplies: true,
        toolPolicyId: policyId,
      });
    }
    expect(byName["artifact.inspect"]).toMatchObject({
      ...runtimeDecision("artifact.inspect"),
      policyApplies: false,
      toolPolicyId: null,
    });
    expect(byName["custom.confirm"]).toMatchObject({
      ...decideToolPolicy(toolAdapterDefinitionFromRecord(clientExtension)),
      matchedRuleIndex: null,
      policyApplies: false,
    });
    expect(byName[archivedTool]).toMatchObject({
      action: "deny",
      basis: "unavailable",
      catalogStatus: "archived",
      reason: `Runtime tool ${archivedTool} is not active.`,
    });
    expect(byName["custom.unknown"]).toMatchObject({
      action: "deny",
      basis: "unavailable",
      catalogStatus: "unknown",
      reason: "Runtime tool custom.unknown is not registered.",
    });
  });

  test("denies connection tools under an archived policy", async () => {
    const response = await evaluate([policy(archivedPolicyId, "archived")], {
      toolNames: ["shopify.products.search", "artifact.inspect"],
      toolPolicyId: archivedPolicyId,
    });
    expect(response.results.map((result) => [result.action, result.basis])).toEqual([
      ["deny", "unavailable"],
      ["allow", "default"],
    ]);
  });

  test("resolves a deployment's pinned grants and policies for its declared tools", async () => {
    const response = await evaluate(
      [
        ...deploymentRecords(),
        policy(policyId, "active"),
        policy(archivedPolicyId, "archived"),
        authorization(authorizationId, ["read_customers", "read_orders"]),
        authorization(narrowAuthorizationId, []),
      ],
      { agentDeploymentId: deploymentId },
    );
    expect(response).toMatchObject({ agentDeploymentId: deploymentId, agentReleaseId: releaseId });
    expect(response.results as unknown).toEqual([
      {
        ...runtimeDecision("shopify.products.search", {
          connectorProvider: "shopify",
          grantedScopes: [],
          policyRules: rules,
        }),
        basis: "required_scopes",
        catalogStatus: "active",
        policyApplies: true,
        toolName: "shopify.products.search",
        toolPolicyId: policyId,
      },
      {
        ...runtimeDecision("shopify.customers.search", {
          connectorProvider: "shopify",
          grantedScopes: ["read_customers"],
          policyRules: rules,
        }),
        action: "require_approval",
        catalogStatus: "active",
        policyApplies: true,
        toolName: "shopify.customers.search",
        toolPolicyId: policyId,
      },
      {
        action: "deny",
        basis: "unavailable",
        catalogStatus: "active",
        matchedRuleIndex: null,
        policyApplies: true,
        reason: "Runtime tool policy is not active.",
        toolName: "shopify.orders.search",
        toolPolicyId: archivedPolicyId,
      },
      {
        action: "deny",
        basis: "unavailable",
        catalogStatus: "active",
        matchedRuleIndex: null,
        policyApplies: true,
        reason: "Agent deployment authorization for shopify.inventory_levels.list is required.",
        toolName: "shopify.inventory_levels.list",
        toolPolicyId: null,
      },
      {
        ...runtimeDecision("artifact.inspect"),
        catalogStatus: "active",
        policyApplies: false,
        toolName: "artifact.inspect",
        toolPolicyId: null,
      },
    ]);
  });

  test("reports undeclared tools and missing resources", async () => {
    const seed = [...deploymentRecords(), policy(policyId, "active")];
    const response = await evaluate(seed, {
      agentDeploymentId: deploymentId,
      toolNames: ["shopify.fulfillments.create"],
    });
    expect(response.results[0]).toMatchObject({
      basis: "unavailable",
      reason: "Agent release does not declare tool capability shopify.fulfillments.create.",
    });
    expect(
      service(seed).invoke(
        "evaluateToolPolicy",
        invocation({ toolNames: ["artifact.inspect"], toolPolicyId: ids[15]! }),
      ),
    ).rejects.toMatchObject({ kind: "not-found" });
    expect(
      service([]).invoke("evaluateToolPolicy", invocation({ agentDeploymentId: deploymentId })),
    ).rejects.toMatchObject({ kind: "not-found" });
  });
});
