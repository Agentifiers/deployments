import type { AgentManifestV1 } from "@deployments-ai/agent-manifest";
import {
  makeManifestModelAdmission,
  makeModelPolicyPersistence,
  makeOrganizationStandingRepository,
  OrganizationRecord,
  StandingActor,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type LoadModelOperatorGrants,
  type PlatformRecord,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { describe, expect, test } from "bun:test";
import {
  controlFixtures,
  environmentId,
  ids,
  memoryDatabase,
  now,
  organizationId,
  projectId,
} from "./conversation-control.fixture.ts";
import {
  DEFAULT_EXECUTION_BINDING_TTL_SECONDS,
  ExecutionBindingManifestNotAdmittedError,
  createExecutionBindingService,
} from "./index.ts";

const scope = { environmentId, organizationId, projectId };
const PRIMARY_MODEL_ID = "openrouter/qwen/qwen3.7-plus";
const FALLBACK_MODEL_ID = "openrouter/z-ai/glm-5.2";

function setup(loadModelOperatorGrants?: LoadModelOperatorGrants) {
  const fixtures = controlFixtures();
  const memory = memoryDatabase([fixtures.release, fixtures.deployment]);
  let next = 8;
  const bindings = createExecutionBindingService({
    admitManifest: makeManifestModelAdmission(memory.database, loadModelOperatorGrants),
    database: memory.database,
    generateId: async () => ids[next++]!,
    now: () => now,
  });
  return { bindings, fixtures, memory };
}

function manifestWithModel(
  manifest: AgentManifestV1,
  model: { readonly fallbackIds?: readonly string[]; readonly id: string },
) {
  return { ...manifest, spec: { ...manifest.spec, model } };
}

function createInput(source: unknown, purpose: "evaluation" | "preview" = "preview") {
  return {
    ...scope,
    createdBy: { id: ids[30]!, type: "principal" as const },
    idempotencyKey: `binding-${purpose}`,
    purpose,
    source: { manifest: source, type: "manifest" as const },
    toolPolicy: purpose === "evaluation" ? ("evaluation" as const) : ("interactive" as const),
    ttlSeconds: DEFAULT_EXECUTION_BINDING_TTL_SECONDS,
  };
}

function writtenItemTypes(records: ReadonlyMap<string, PlatformRecord>) {
  return [...records.values()].map((record) => record.itemType);
}

async function setPhiDataBoundary(database: DynamoDatabaseService) {
  await database.putRecord(
    Schema.decodeUnknownSync(OrganizationRecord)(
      withCanonicalRecordKeys({
        data: {
          createdAt: now.toISOString(),
          id: organizationId,
          name: "Clinic",
          slug: "clinic",
          status: "active",
          updatedAt: now.toISOString(),
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
    actor: Schema.decodeUnknownSync(StandingActor)({ kind: "operator", principalId: ids[31]! }),
    operatorNote: "BAA on file.",
    organizationId,
    profile: "phi",
  });
}

async function allowOnlyModel(database: DynamoDatabaseService, modelId: string) {
  await makeModelPolicyPersistence(database, {
    generateId: async () => ids[39]!,
    now: () => now,
  }).create(
    scope,
    { includeCuratedModels: false, models: [modelId], name: "Single model" },
    { principalId: ids[30]! },
  );
}

describe("execution binding model admission", () => {
  test("rejects a binding whose primary model the curated defaults do not admit", async () => {
    const { bindings, fixtures, memory } = setup();
    const before = writtenItemTypes(memory.records);

    const rejected = bindings.createExecutionBinding(
      createInput(
        manifestWithModel(fixtures.release.data.manifest, { id: "openrouter/vendor/unlisted" }),
      ),
    );

    expect(rejected).rejects.toBeInstanceOf(ExecutionBindingManifestNotAdmittedError);
    expect(rejected).rejects.toMatchObject({
      code: "model_not_allowed_by_environment_policy",
      message: expect.stringContaining("/spec/model/id:"),
    });
    expect(memory.transactions).toHaveLength(0);
    expect(writtenItemTypes(memory.records)).toEqual(before);
  });

  test("admits primary and fallback models against the active environment policy", async () => {
    const { bindings, fixtures, memory } = setup();
    await allowOnlyModel(memory.database, PRIMARY_MODEL_ID);
    const transactionsAfterPolicy = memory.transactions.length;
    const before = writtenItemTypes(memory.records);

    const rejected = bindings.createExecutionBinding(
      createInput(
        manifestWithModel(fixtures.release.data.manifest, {
          fallbackIds: [FALLBACK_MODEL_ID],
          id: PRIMARY_MODEL_ID,
        }),
        "evaluation",
      ),
    );
    expect(rejected).rejects.toMatchObject({
      code: "model_not_allowed_by_environment_policy",
      message: expect.stringContaining("/spec/model/fallbackIds/0:"),
    });
    expect(memory.transactions).toHaveLength(transactionsAfterPolicy);
    expect(writtenItemTypes(memory.records)).toEqual(before);

    const admitted = await bindings.createExecutionBinding(
      createInput(manifestWithModel(fixtures.release.data.manifest, { id: PRIMARY_MODEL_ID })),
    );
    expect(admitted).toMatchObject({
      binding: { data: { manifest: { spec: { model: { id: PRIMARY_MODEL_ID } } } } },
      created: true,
    });
  });

  test("rejects an evaluation binding of a release whose model the policy no longer admits", async () => {
    const { bindings, fixtures, memory } = setup();
    await allowOnlyModel(memory.database, FALLBACK_MODEL_ID);
    const before = writtenItemTypes(memory.records);

    expect(
      bindings.createExecutionBinding({
        ...createInput(undefined, "evaluation"),
        source: { agentReleaseId: fixtures.release.data.id, type: "release" },
      }),
    ).rejects.toMatchObject({ code: "model_not_allowed_by_environment_policy" });
    expect(writtenItemTypes(memory.records)).toEqual(before);
  });

  test("admits a release binding whose agent's operator grant lists the model", async () => {
    const { fixtures } = setup();
    // The release pins PRIMARY_MODEL_ID, which the environment policy excludes.
    const { bindings, memory } = setup(async () => [
      {
        agentId: fixtures.release.data.agentDefinitionId,
        allowedModels: [PRIMARY_MODEL_ID],
        organizationId,
        providers: ["openrouter"],
      },
    ]);
    await allowOnlyModel(memory.database, FALLBACK_MODEL_ID);

    expect(
      bindings.createExecutionBinding({
        ...createInput(undefined, "evaluation"),
        source: { agentReleaseId: fixtures.release.data.id, type: "release" },
      }),
    ).resolves.toMatchObject({ created: true });
    // An inline manifest names no agent, so the agent's grant does not apply to it.
    expect(
      bindings.createExecutionBinding(
        createInput(manifestWithModel(fixtures.release.data.manifest, { id: PRIMARY_MODEL_ID })),
      ),
    ).rejects.toMatchObject({ code: "model_not_allowed_by_environment_policy" });
  });

  test("rejects an evaluation binding of a release whose model a phi boundary excludes", async () => {
    const { bindings, fixtures, memory } = setup();
    await setPhiDataBoundary(memory.database);
    const before = writtenItemTypes(memory.records);

    const rejected = bindings.createExecutionBinding({
      ...createInput(undefined, "evaluation"),
      source: { agentReleaseId: fixtures.release.data.id, type: "release" },
    });

    expect(rejected).rejects.toBeInstanceOf(ExecutionBindingManifestNotAdmittedError);
    expect(rejected).rejects.toMatchObject({
      code: "model_outside_data_boundary",
      message: expect.stringContaining("/spec/model/id:"),
    });
    expect(writtenItemTypes(memory.records)).toEqual(before);
  });
});
