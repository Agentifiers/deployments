import { describe, expect, it } from "bun:test";
import { modelGatewayGenerationPort } from "@deployments-ai/agent-runtime";
import {
  makeModelCatalogPersistence,
  makeModelPolicyPersistence,
  type DynamoDatabaseService,
} from "@deployments-ai/db";
import {
  operatorGrantAllowsModel,
  type ModelGatewayChatCompletionRequest,
  type ModelGatewayService,
  type ModelOperatorGrant,
} from "@deployments-ai/model-gateway";
import { Effect } from "effect";
import { processAgentRun } from "./index.ts";
import type {
  AgentReleaseRecordValue,
  AgentRunWorkerDependencies,
  RunRecordValue,
} from "./types.ts";
import {
  fixtures,
  id,
  inMemoryDatabase,
  releaseWithManifest,
  workerDependencies,
} from "./agent-run.fixture.ts";

const CATALOG_MODEL_ID = "openrouter/acme/long-context";
const CURATED_FALLBACK_ID = "openrouter/z-ai/glm-5.2";
const catalogPricing = { inputUsdPerMillionTokens: 0.4, outputUsdPerMillionTokens: 1.6 };
/** Neither curated nor in the catalog: only an operator grant admits it. */
const GRANTED_MODEL_ID = "openrouter/vendor/operator-granted";

function pinnedToGrantedModel(release: AgentReleaseRecordValue) {
  const manifest = release.data.manifest;
  return releaseWithManifest(release, {
    ...manifest,
    spec: {
      ...manifest.spec,
      model: { id: GRANTED_MODEL_ID },
      runtime: {
        ...manifest.spec.runtime,
        modelInputTokenBudget: 32_000,
        modelOutputTokenReserve: 1_024,
      },
    },
  });
}

function pinnedToCatalogModel(release: AgentReleaseRecordValue) {
  const manifest = release.data.manifest;
  return releaseWithManifest(release, {
    ...manifest,
    spec: {
      ...manifest.spec,
      model: { fallbackIds: [CURATED_FALLBACK_ID], id: CATALOG_MODEL_ID },
    },
  });
}

async function seedCatalogModel(database: DynamoDatabaseService) {
  await makeModelCatalogPersistence(database).synchronizeProvider("openrouter", [
    {
      capabilities: {
        imageInput: false,
        reasoning: false,
        structuredOutputs: true,
        toolCalling: true,
      },
      contextWindowTokens: 262_144,
      displayName: "Acme Long Context",
      maximumOutputTokens: 2_048,
      modelId: CATALOG_MODEL_ID,
      pricing: catalogPricing,
      provider: "openrouter",
      providerModelId: "acme/long-context",
    },
  ]);
}

function scopeOf(run: RunRecordValue) {
  return {
    environmentId: run.data.environmentId,
    organizationId: run.data.organizationId,
    projectId: run.data.projectId,
  };
}

describe("agent run model admission", () => {
  it("fails the run closed when the environment policy no longer allows its pinned model", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase([
      pinnedToCatalogModel(fixture.release),
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    await seedCatalogModel(memory.database);
    const policies = makeModelPolicyPersistence(memory.database);
    const policy = await policies.create(
      scopeOf(fixture.run),
      { includeCuratedModels: true, models: [CATALOG_MODEL_ID], name: "Catalog models" },
      { principalId: id(11) },
    );
    await policies.update(
      scopeOf(fixture.run),
      policy.id,
      { expectedVersion: policy.version, models: [] },
      { principalId: id(11) },
    );
    const { dependencies } = workerDependencies(memory.database);
    let generations = 0;
    const result = await processAgentRun(fixture.queue, {
      ...dependencies,
      runtime: {
        generateAssistantMessage: async () => {
          generations += 1;
          return { assistantMessage: "must not run" };
        },
      },
    });

    expect(generations).toBe(0);
    expect(result).toMatchObject({ action: "skipped", run: { data: { status: "failed" } } });
    const error = result.run?.data.error?.message ?? "";
    expect(error).toContain("model_not_allowed_by_environment_policy");
    expect(error).toContain(CATALOG_MODEL_ID);
    const redelivered = await processAgentRun(fixture.queue, dependencies);
    expect(redelivered.run?.data.status).toBe("failed");
    expect(generations).toBe(0);
  });

  it("carries an admitted catalog model's limits and pricing into the gateway request", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase([
      pinnedToCatalogModel(fixture.release),
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    await seedCatalogModel(memory.database);
    await makeModelPolicyPersistence(memory.database).create(
      scopeOf(fixture.run),
      { includeCuratedModels: true, models: ["openrouter/*"], name: "OpenRouter catalog" },
      { principalId: id(11) },
    );
    const captured: ModelGatewayChatCompletionRequest[] = [];
    const gateway = {
      chatCompletion: (request: ModelGatewayChatCompletionRequest) => {
        captured.push(request);
        return Effect.succeed({
          assistantMessage: "Answered with the catalog model.",
          body: {},
          modelCallId: request.modelCallId,
          route: {},
        } as never);
      },
    } as unknown as ModelGatewayService;
    const { dependencies } = workerDependencies(memory.database);
    const withGateway: AgentRunWorkerDependencies = {
      ...dependencies,
      runtime: { generateAssistantMessage: modelGatewayGenerationPort(gateway) },
    };

    const result = await processAgentRun(fixture.queue, withGateway);

    expect(result.action).toBe("completed");
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      maxTokens: 2_048,
      modelCatalog: {
        [CATALOG_MODEL_ID]: {
          contextWindowTokens: 262_144,
          maximumOutputTokens: 2_048,
          pricing: catalogPricing,
        },
      },
      modelId: CATALOG_MODEL_ID,
    });
    expect(Object.keys(captured[0]!.modelCatalog ?? {})).toEqual([CATALOG_MODEL_ID]);
  });

  it("runs a model the agent's operator grant lists and fails it once the grant is gone", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase([
      pinnedToGrantedModel(fixture.release),
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    const grants: ModelOperatorGrant[] = [
      {
        agentId: fixture.release.data.agentDefinitionId,
        allowedModels: [GRANTED_MODEL_ID],
        organizationId: fixture.run.data.organizationId,
        providers: ["openrouter"],
      },
    ];
    const captured: ModelGatewayChatCompletionRequest[] = [];
    const gateway = {
      chatCompletion: (request: ModelGatewayChatCompletionRequest) => {
        captured.push(request);
        return Effect.succeed({
          assistantMessage: "Answered with the granted model.",
          body: {},
          modelCallId: request.modelCallId,
          route: {},
        } as never);
      },
    } as unknown as ModelGatewayService;
    const { dependencies } = workerDependencies(memory.database);

    const result = await processAgentRun(fixture.queue, {
      ...dependencies,
      loadModelOperatorGrants: async () => grants,
      runtime: { generateAssistantMessage: modelGatewayGenerationPort(gateway) },
    });

    expect(result.action).toBe("completed");
    expect(captured).toHaveLength(1);
    // Admission used the scope the agent runtime sends with the run's model calls.
    expect(captured[0]!.modelId).toBe(GRANTED_MODEL_ID);
    expect(operatorGrantAllowsModel(grants, captured[0]!.scope!, GRANTED_MODEL_ID)).toBe(true);

    const revoked = fixtures();
    const revokedMemory = inMemoryDatabase([
      pinnedToGrantedModel(revoked.release),
      revoked.deployment,
      revoked.thread,
      revoked.userMessage,
      revoked.run,
    ]);
    const failed = await processAgentRun(revoked.queue, {
      ...workerDependencies(revokedMemory.database).dependencies,
      loadModelOperatorGrants: async () => [{ ...grants[0]!, allowedModels: ["*"] }],
      runtime: { generateAssistantMessage: modelGatewayGenerationPort(gateway) },
    });
    expect(failed).toMatchObject({ action: "skipped", run: { data: { status: "failed" } } });
    expect(failed.run?.data.error?.message).toContain("model_not_allowed_by_environment_policy");
    expect(captured).toHaveLength(1);
  });
});
