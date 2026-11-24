import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  ENVIRONMENT,
  GENERATED_IDS,
  OTHER_ENVIRONMENT_ID,
  invocation,
  makeService,
  manifest,
  storageKey,
} from "./agent-lifecycle-test-support.ts";
import {
  ToolAdapterRecord,
  UniqueClaimRecord,
  makeUniqueClaimRecord,
  tableForItemType,
  uniqueClaimRequirements,
  withCanonicalRecordKeys,
  type AdmitManifest,
  type AgentEnvironmentScope,
  type AgentLifecyclePersistence,
  type AgentModelAdmissionScope,
  type PlatformRecord,
} from "./index.ts";

const TARGET = { ...ENVIRONMENT, id: OTHER_ENVIRONMENT_ID } as AgentEnvironmentScope;
const CREATED_AT = "2026-07-25T12:00:00.000Z";
const READ_CONFIG = {
  apiVersion: "agents.deployments.ai/v1",
  kind: "AgentDeploymentConfig",
  toolAuthorizations: { "records.read": { authorizationId: GENERATED_IDS[19] } },
} as const;

/** Registers `records.read` (bound by the test manifest) as an active client-executed tool. */
function seedClientTool(records: Map<string, PlatformRecord>, environmentId: string) {
  const adapter = Schema.decodeUnknownSync(ToolAdapterRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: CREATED_AT,
        defaultPolicyAction: "allow",
        description: "Read records on the caller's device.",
        effect: "read",
        environmentId,
        execution: { timeoutMs: 60_000, type: "client" },
        id: "01ARZ3NDEKTSV4RRFFQ69G5FE0",
        inputSchema: { type: "object" },
        name: "records.read",
        organizationId: ENVIRONMENT.organizationId,
        projectId: ENVIRONMENT.projectId,
        requiredScopes: [],
        status: "active",
        updatedAt: CREATED_AT,
        version: 0,
      },
      itemType: "tool-adapter",
    }),
  );
  for (const record of [
    adapter,
    ...uniqueClaimRequirements(adapter).map((requirement) =>
      Schema.decodeUnknownSync(UniqueClaimRecord)(makeUniqueClaimRecord(requirement, CREATED_AT)),
    ),
  ]) {
    records.set(storageKey(tableForItemType(record.itemType), record), record);
  }
}

/** Denies every model once `deny` holds for the admission scope; records every scope checked. */
function modelGate() {
  const scopes: AgentModelAdmissionScope[] = [];
  let deny: (scope: AgentModelAdmissionScope) => boolean = () => false;
  const admit: AdmitManifest = async (scope, candidate) => {
    scopes.push(scope);
    return deny(scope)
      ? [
          {
            code: "model_not_allowed_by_environment_policy",
            message: `Model ${candidate.spec.model.id} is not allowed.`,
            path: "/spec/model/id",
          },
        ]
      : [];
  };
  return {
    admit,
    scopes,
    setDeny(next: (scope: AgentModelAdmissionScope) => boolean) {
      deny = next;
    },
  };
}

async function deploymentWithTwoReleases(service: AgentLifecyclePersistence) {
  const definition = await service.agentDefinitions.create(invocation({ manifest: manifest() }));
  const first = await service.agentReleases.publish(
    invocation({ expectedDefinitionVersion: 0 }, { id: definition.id }),
  );
  const second = await service.agentReleases.publish(
    invocation({ expectedDefinitionVersion: 1 }, { id: definition.id }),
  );
  const deployment = await service.agentDeployments.create(
    invocation({ agentReleaseId: first.id, runtimeConfig: READ_CONFIG }),
  );
  return { deployment, first, second };
}

function retarget(service: AgentLifecyclePersistence, deploymentId: string, releaseId: string) {
  return service.agentDeployments.update(
    invocation({ agentReleaseId: releaseId, expectedVersion: 0 }, { id: deploymentId }),
  );
}

function startCanary(service: AgentLifecyclePersistence, deploymentId: string, releaseId: string) {
  return service.agentDeployments.startCanary(
    invocation(
      { candidateAgentReleaseId: releaseId, expectedVersion: 0, weight: 10 },
      { id: deploymentId },
    ),
  );
}

describe("client tool trigger rule on release re-binding", () => {
  test("rejects retargeting and canaries onto a release that binds a client tool autonomously", async () => {
    const { records, service } = makeService();
    const { deployment, first, second } = await deploymentWithTwoReleases(service);
    // The extension becomes client-executed after both releases were published.
    seedClientTool(records, ENVIRONMENT.id);

    expect(retarget(service, deployment.id, second.id)).rejects.toMatchObject({
      code: "client_tool_on_autonomous_trigger",
      kind: "unprocessable",
    });
    expect(startCanary(service, deployment.id, second.id)).rejects.toMatchObject({
      code: "client_tool_on_autonomous_trigger",
      kind: "unprocessable",
    });
    expect(
      service.agentDeployments.get(invocation(undefined, { id: deployment.id })),
    ).resolves.toMatchObject({ agentReleaseId: first.id, version: 0 });
  });

  test("rejects promotion into an environment where a bound tool is client-executed", async () => {
    const { records, service } = makeService([ENVIRONMENT, TARGET]);
    const { second } = await deploymentWithTwoReleases(service);
    seedClientTool(records, TARGET.id);

    expect(
      service.agentReleases.promote(
        invocation({ targetEnvironmentId: TARGET.id }, { id: second.id }),
      ),
    ).rejects.toMatchObject({ code: "client_tool_on_autonomous_trigger" });
    expect(
      [...records.values()].some(
        (record) => record.itemType === "agent-release" && record.data.environmentId === TARGET.id,
      ),
    ).toBe(false);
  });
});

describe("model policy admission on release re-binding", () => {
  test("rejects retargeting a paused deployment and starting a canary on a disallowed release", async () => {
    const gate = modelGate();
    const { service } = makeService([ENVIRONMENT], gate.admit);
    const { deployment, first, second } = await deploymentWithTwoReleases(service);
    gate.setDeny(() => true);

    expect(startCanary(service, deployment.id, second.id)).rejects.toMatchObject({
      code: "model_not_allowed_by_environment_policy",
      kind: "unprocessable",
    });
    expect(retarget(service, deployment.id, second.id)).rejects.toMatchObject({
      code: "model_not_allowed_by_environment_policy",
    });
    gate.setDeny(() => false);
    const paused = await service.agentDeployments.update(
      invocation({ desiredState: "paused", expectedVersion: 0 }, { id: deployment.id }),
    );
    gate.setDeny(() => true);
    expect(
      service.agentDeployments.update(
        invocation(
          { agentReleaseId: second.id, expectedVersion: paused.version },
          { id: deployment.id },
        ),
      ),
    ).rejects.toMatchObject({ code: "model_not_allowed_by_environment_policy" });
    expect(
      service.agentDeployments.get(invocation(undefined, { id: deployment.id })),
    ).resolves.toMatchObject({ agentReleaseId: first.id, desiredState: "paused" });
  });

  test("admits a promoted release against the target environment's policy", async () => {
    const gate = modelGate();
    const { records, service } = makeService([ENVIRONMENT, TARGET], gate.admit);
    const { second } = await deploymentWithTwoReleases(service);
    gate.setDeny((scope) => scope.environmentId === TARGET.id);

    expect(
      service.agentReleases.promote(
        invocation({ targetEnvironmentId: TARGET.id }, { id: second.id }),
      ),
    ).rejects.toMatchObject({ code: "model_not_allowed_by_environment_policy" });
    expect(gate.scopes.at(-1)).toEqual({
      environmentId: TARGET.id,
      organizationId: TARGET.organizationId,
      projectId: TARGET.projectId,
    });
    expect(
      [...records.values()].some(
        (record) => record.itemType === "agent-release" && record.data.environmentId === TARGET.id,
      ),
    ).toBe(false);

    gate.setDeny(() => false);
    expect(
      service.agentReleases.promote(
        invocation({ targetEnvironmentId: TARGET.id }, { id: second.id }),
      ),
    ).resolves.toMatchObject({ created: true, release: { environmentId: TARGET.id } });
  });
});
