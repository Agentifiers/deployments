import { describe, expect, test } from "bun:test";
import {
  composeManifestAdmission,
  makeAgentLifecyclePersistence,
  makeManifestModelAdmission,
  makeModelCatalogPersistence,
  makeModelPolicyPersistence,
  makeOrganizationStandingRepository,
  OrganizationRecord,
  StandingActor,
  withCanonicalRecordKeys,
  type AgentEnvironmentScope,
  type PersistenceInvocation,
} from "@deployments-ai/db";
import type { ModelOperatorGrant } from "@deployments-ai/model-gateway";
import { makeManifestToolBoundaryAdmission } from "@deployments-ai/tools";
import { Schema } from "effect";
import {
  ENVIRONMENT,
  ENVIRONMENT_ID,
  ORGANIZATION_ID,
  PRINCIPAL_ID,
  PROJECT_ID,
  catalogEntry,
  generateId,
  memoryDatabase,
} from "./model-policy.fixture.ts";

const SCOPE = {
  environmentId: ENVIRONMENT_ID,
  organizationId: ORGANIZATION_ID,
  projectId: PROJECT_ID,
};
const CLAUDE = "openrouter/anthropic/claude-sonnet-4.6";
/** Neither curated nor in the synchronized catalog; reachable only through an operator grant. */
const GRANTED_OPENROUTER = "openrouter/vendor/operator-granted";
const OTHER_AGENT_GRANTED = "openrouter/vendor/other-agent-granted";
const BEDROCK_HAIKU = "bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0";
const OPERATOR = Schema.decodeUnknownSync(StandingActor)({
  kind: "operator",
  principalId: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
});
const RUNTIME_CONFIG = {
  apiVersion: "agents.deployments.ai/v1",
  kind: "AgentDeploymentConfig",
  toolAuthorizations: { "records.read": { authorizationId: "01ARZ3NDEKTSV4RRFFQ69G5FB5" } },
} as const;

interface ManifestModel {
  readonly fallbackIds?: readonly string[];
  readonly id: string;
}

interface ManifestRuntime {
  readonly ingressAttachments?: "attach";
  /** The one declared tool; `records.read` resolves to no registered tool. */
  readonly toolName?: string;
}

function manifest(
  model: ManifestModel,
  key: string,
  { toolName = "records.read", ...runtime }: ManifestRuntime = {},
) {
  return {
    apiVersion: "agents.deployments.ai/v1",
    kind: "Agent",
    metadata: { key, name: "Example Assistant", version: "1.0.0" },
    spec: {
      capabilities: {
        tools: [
          {
            authorization: "workspace",
            name: toolName,
            required: true,
            requiredScopes: ["records:read"],
          },
        ],
      },
      instructions: "Answer using the available records.",
      model,
      runtime: {
        ...runtime,
        toolRequests: [
          {
            effect: "read",
            idempotencyKey: "records-read",
            inputSummary: "Read records.",
            requiredScopes: ["records:read"],
            toolName,
          },
        ],
      },
      sandbox: { mode: "none" },
    },
  } as const;
}

function invocation<Body>(body: Body, id?: string): PersistenceInvocation<Body> {
  return {
    body,
    identity: { principalId: PRINCIPAL_ID },
    idempotencyKey: `admission-${id ?? "new"}`,
    ...(id ? { id } : {}),
    query: {},
    scope: { environmentId: ENVIRONMENT_ID },
  };
}

async function harness() {
  const { database } = memoryDatabase();
  await makeModelCatalogPersistence(database).synchronizeProvider("openrouter", [
    catalogEntry(CLAUDE),
  ]);
  const grants: ModelOperatorGrant[] = [];
  const lifecycle = makeAgentLifecyclePersistence({
    admitManifest: composeManifestAdmission(
      makeManifestModelAdmission(database, async () => grants),
      makeManifestToolBoundaryAdmission({ database }),
    ),
    database,
    generateId,
    resolveEnvironment: async () => ENVIRONMENT as unknown as AgentEnvironmentScope,
  });
  const policies = makeModelPolicyPersistence(database, { generateId });
  let definitions = 0;
  const publish = async (model: ManifestModel, runtime?: ManifestRuntime) => {
    definitions += 1;
    const definition = await lifecycle.agentDefinitions.create(
      invocation({ manifest: manifest(model, `example.assistant-${definitions}`, runtime) }),
    );
    return lifecycle.agentReleases.publish(
      invocation({ expectedDefinitionVersion: definition.version }, definition.id),
    );
  };
  const createDefinition = async (model: ManifestModel) => {
    definitions += 1;
    return lifecycle.agentDefinitions.create(
      invocation({ manifest: manifest(model, `example.assistant-${definitions}`) }),
    );
  };
  const setPhiDataBoundary = async () => {
    await database.putRecord(
      Schema.decodeUnknownSync(OrganizationRecord)(
        withCanonicalRecordKeys({
          data: {
            createdAt: "2026-01-01T00:00:00.000Z",
            id: ORGANIZATION_ID,
            name: "Clinic",
            slug: "clinic",
            status: "active",
            updatedAt: "2026-01-01T00:00:00.000Z",
            version: 1,
          },
          itemType: "organization",
        }),
      ),
    );
    await makeOrganizationStandingRepository({
      database,
      installDefaults: {
        operatorFundedModelSpendCeiling: "unlimited",
        tenantLimits: {
          activeSandboxes: 1,
          apiRequestBurst: 40,
          apiRequestsPerSecond: 20,
          concurrentRuns: 2,
        },
      },
    }).setDataBoundary({
      actor: OPERATOR,
      operatorNote: "BAA on file.",
      organizationId: ORGANIZATION_ID as never,
      profile: "phi",
    });
  };
  return { createDefinition, grants, lifecycle, policies, publish, setPhiDataBoundary };
}

describe("manifest model admission", () => {
  test("publishes curated models without an environment model policy", async () => {
    const { publish } = await harness();
    expect(
      publish({ fallbackIds: ["openai/gpt-4.1"], id: "openai/gpt-4o" }),
    ).resolves.toMatchObject({ releaseNumber: 1 });
  });

  test("rejects publishing models outside the environment's effective policy", async () => {
    const { policies, publish } = await harness();
    expect(publish({ id: CLAUDE })).rejects.toMatchObject({
      code: "model_not_allowed_by_environment_policy",
      kind: "unprocessable",
    });

    await policies.create(
      SCOPE,
      { includeCuratedModels: false, models: [CLAUDE], name: "Sonnet only" },
      { principalId: PRINCIPAL_ID },
    );
    const rejected = await publish({ fallbackIds: ["openai/gpt-4o"], id: CLAUDE }).catch(
      (cause: unknown) => cause,
    );
    expect(rejected).toMatchObject({
      code: "model_not_allowed_by_environment_policy",
      kind: "unprocessable",
    });
    expect((rejected as Error).message).toStartWith("/spec/model/fallbackIds/0: ");
    expect(publish({ id: CLAUDE })).resolves.toMatchObject({ releaseNumber: 1 });
  });

  test("rejects an invalid model id with its own code outside any data boundary", async () => {
    const { publish } = await harness();
    const rejected = await publish({ id: "openrouter/" }).catch((cause: unknown) => cause);
    expect(rejected).toMatchObject({ code: "invalid_model_id", kind: "unprocessable" });
  });

  test("publishes ingressAttachments: attach on a primary that cannot read images", async () => {
    const { publish } = await harness();
    expect(
      publish({ id: "openrouter/z-ai/glm-5.2" }, { ingressAttachments: "attach" }),
    ).resolves.toMatchObject({
      manifest: {
        spec: {
          model: { id: "openrouter/z-ai/glm-5.2" },
          runtime: { ingressAttachments: "attach" },
        },
      },
      releaseNumber: 1,
    });
  });

  test("rejects deploying a release whose model the environment no longer allows", async () => {
    const { lifecycle, policies, publish } = await harness();
    const policy = await policies.create(
      SCOPE,
      { includeCuratedModels: true, models: ["openrouter/*"], name: "Hosted" },
      { principalId: PRINCIPAL_ID },
    );
    const release = await publish({ id: CLAUDE });
    await policies.archive(SCOPE, policy.id, policy.version, { principalId: PRINCIPAL_ID });

    expect(
      lifecycle.agentDeployments.create(
        invocation({ agentReleaseId: release.id, runtimeConfig: RUNTIME_CONFIG }),
      ),
    ).rejects.toMatchObject({
      code: "model_not_allowed_by_environment_policy",
      kind: "unprocessable",
    });
  });

  test("admits models an agent's operator grant lists at publish and deploy", async () => {
    const { createDefinition, grants, lifecycle, publish } = await harness();
    const granted = await createDefinition({ id: GRANTED_OPENROUTER });
    grants.push(
      {
        agentId: granted.id,
        allowedModels: [GRANTED_OPENROUTER],
        organizationId: ORGANIZATION_ID,
        providers: ["openrouter"],
      },
      // Another agent's grant never widens this agent's admission.
      {
        agentId: "01ARZ3NDEKTSV4RRFFQ69G5FZZ",
        allowedModels: [OTHER_AGENT_GRANTED],
        organizationId: ORGANIZATION_ID,
        providers: ["openrouter"],
      },
    );

    const release = await lifecycle.agentReleases.publish(
      invocation({ expectedDefinitionVersion: granted.version }, granted.id),
    );
    expect(
      lifecycle.agentDeployments.create(
        invocation({ agentReleaseId: release.id, runtimeConfig: RUNTIME_CONFIG }),
      ),
    ).resolves.toMatchObject({ agentReleaseId: release.id });

    expect(publish({ id: GRANTED_OPENROUTER })).rejects.toMatchObject({
      code: "model_not_allowed_by_environment_policy",
      kind: "unprocessable",
    });
    expect(publish({ id: OTHER_AGENT_GRANTED })).rejects.toMatchObject({
      code: "model_not_allowed_by_environment_policy",
    });
  });

  test("admits a policy-excluded model only while a grant explicitly lists it", async () => {
    const { createDefinition, grants, lifecycle, policies } = await harness();
    await policies.create(
      SCOPE,
      { includeCuratedModels: false, models: [CLAUDE], name: "Sonnet only" },
      { principalId: PRINCIPAL_ID },
    );
    const definition = await createDefinition({ id: GRANTED_OPENROUTER });
    const grant: ModelOperatorGrant = {
      agentId: definition.id,
      allowedModels: [GRANTED_OPENROUTER],
      organizationId: ORGANIZATION_ID,
      providers: ["openrouter"],
    };
    grants.push(grant);
    const release = await lifecycle.agentReleases.publish(
      invocation({ expectedDefinitionVersion: definition.version }, definition.id),
    );
    expect(release.manifest.spec.model.id).toBe(GRANTED_OPENROUTER);

    grants.splice(0, grants.length, { ...grant, allowedModels: ["*"] });
    expect(
      lifecycle.agentDeployments.create(
        invocation({ agentReleaseId: release.id, runtimeConfig: RUNTIME_CONFIG }),
      ),
    ).rejects.toMatchObject({ code: "model_not_allowed_by_environment_policy" });
  });

  describe("in a phi data boundary", () => {
    test("rejects publishing a model outside the boundary at its pointer", async () => {
      const { publish, setPhiDataBoundary } = await harness();
      await setPhiDataBoundary();

      const rejected = await publish(
        { fallbackIds: ["openai/gpt-4o"], id: BEDROCK_HAIKU },
        { toolName: "agent.memory.search" },
      ).catch((cause: unknown) => cause);

      expect(rejected).toMatchObject({
        code: "model_outside_data_boundary",
        kind: "unprocessable",
      });
      expect((rejected as Error).message).toStartWith(
        "/spec/model/fallbackIds/0: Model openai/gpt-4o is outside this organization's phi data boundary",
      );
    });

    test("rejects publishing a tool whose destinations its input cannot name", async () => {
      const { publish, setPhiDataBoundary } = await harness();
      await setPhiDataBoundary();

      const rejected = await publish({ id: BEDROCK_HAIKU }, { toolName: "code.execute" }).catch(
        (cause: unknown) => cause,
      );

      expect(rejected).toMatchObject({ code: "tool_outside_data_boundary", kind: "unprocessable" });
      expect((rejected as Error).message).toStartWith("/spec/capabilities/tools/0: ");
    });

    test("publishes a public tool whose calls name their destinations", async () => {
      const { publish, setPhiDataBoundary } = await harness();
      await setPhiDataBoundary();

      expect(publish({ id: BEDROCK_HAIKU }, { toolName: "web.scrape" })).resolves.toMatchObject({
        releaseNumber: 1,
      });
    });

    test("rejects deploying a release published before the organization was classified", async () => {
      const { lifecycle, publish, setPhiDataBoundary } = await harness();
      const release = await publish({ id: "openai/gpt-4o" }, { toolName: "agent.memory.search" });
      await setPhiDataBoundary();

      expect(
        lifecycle.agentDeployments.create(
          invocation({
            agentReleaseId: release.id,
            runtimeConfig: {
              ...RUNTIME_CONFIG,
              toolAuthorizations: {
                "agent.memory.search": RUNTIME_CONFIG.toolAuthorizations["records.read"],
              },
            },
          }),
        ),
      ).rejects.toMatchObject({ code: "model_outside_data_boundary", kind: "unprocessable" });
    });

    test("publishes a Bedrock-only manifest that declares only platform tools", async () => {
      const { publish, setPhiDataBoundary } = await harness();
      await setPhiDataBoundary();

      expect(
        publish({ id: BEDROCK_HAIKU }, { toolName: "agent.memory.search" }),
      ).resolves.toMatchObject({ releaseNumber: 1 });
    });
  });
});
