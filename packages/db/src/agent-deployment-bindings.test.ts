import type { AgentManifestV1 } from "@deployments-ai/agent-manifest";
import { describe, expect, test } from "bun:test";
import {
  GENERATED_IDS,
  invocation,
  makeService,
  manifest,
} from "./agent-lifecycle-test-support.ts";
import type { AgentLifecyclePersistence } from "./index.ts";

const READ_AUTHORIZATION = {
  "records.read": { authorizationId: GENERATED_IDS[19] },
} as const;

function config(agentBindings?: Readonly<Record<string, { readonly agentDeploymentId: string }>>) {
  return {
    apiVersion: "agents.deployments.ai/v1",
    kind: "AgentDeploymentConfig",
    ...(agentBindings ? { agentBindings } : {}),
    toolAuthorizations: READ_AUTHORIZATION,
  } as const;
}

function orchestratorManifest() {
  const base = manifest("example.orchestrator", "Example Orchestrator");
  return {
    ...base,
    spec: {
      ...base.spec,
      agents: [
        {
          agentKey: "research.agent",
          awaitResult: true,
          description: "Researches questions.",
          key: "researcher",
          required: true,
        },
      ],
      capabilities: {
        tools: [
          ...base.spec.capabilities.tools,
          { name: "agent.delegate", required: true, requiredScopes: [] },
        ],
      },
      runtime: { ...base.spec.runtime, modelTools: ["agent.delegate"] },
    },
  } as const;
}

async function deployedAgent(service: AgentLifecyclePersistence, agentManifest: AgentManifestV1) {
  const definition = await service.agentDefinitions.create(invocation({ manifest: agentManifest }));
  const release = await service.agentReleases.publish(
    invocation({ expectedDefinitionVersion: 0 }, { id: definition.id }),
  );
  return { definition, release };
}

async function scenario() {
  const { service } = makeService();
  const specialist = await deployedAgent(service, manifest("research.agent", "Researcher"));
  const specialistDeployment = await service.agentDeployments.create(
    invocation({ agentReleaseId: specialist.release.id, runtimeConfig: config() }),
  );
  const unrelated = await deployedAgent(service, manifest("unrelated.agent", "Unrelated"));
  const unrelatedDeployment = await service.agentDeployments.create(
    invocation({ agentReleaseId: unrelated.release.id, runtimeConfig: config() }),
  );
  const orchestrator = await deployedAgent(service, orchestratorManifest());
  return { orchestrator, service, specialistDeployment, unrelatedDeployment };
}

describe("sub-agent deployment bindings", () => {
  test("binds a declared sub-agent to a deployment running the declared agent key", async () => {
    const { orchestrator, service, specialistDeployment } = await scenario();
    const deployment = await service.agentDeployments.create(
      invocation({
        agentReleaseId: orchestrator.release.id,
        runtimeConfig: config({ researcher: { agentDeploymentId: specialistDeployment.id } }),
      }),
    );
    expect(deployment.runtimeConfig?.agentBindings).toEqual({
      researcher: { agentDeploymentId: specialistDeployment.id },
    });
  });

  test("rejects missing, unknown, mismatched, stopped, and self bindings", async () => {
    const { orchestrator, service, specialistDeployment, unrelatedDeployment } = await scenario();
    const deploy = (
      agentBindings?: Readonly<Record<string, { readonly agentDeploymentId: string }>>,
    ) =>
      service.agentDeployments.create(
        invocation({
          agentReleaseId: orchestrator.release.id,
          runtimeConfig: config(agentBindings),
        }),
      );
    expect(deploy()).rejects.toMatchObject({
      code: "invalid_agent_deployment_config",
      message: expect.stringContaining("/agentBindings/researcher"),
    });
    expect(deploy({ researcher: { agentDeploymentId: GENERATED_IDS[18] } })).rejects.toMatchObject({
      code: "invalid_agent_deployment_config",
      message: expect.stringContaining("not found in this environment"),
    });
    expect(
      deploy({ researcher: { agentDeploymentId: unrelatedDeployment.id } }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("does not run agent key research.agent"),
    });

    const bound = await deploy({ researcher: { agentDeploymentId: specialistDeployment.id } });
    expect(
      service.agentDeployments.update(
        invocation(
          {
            expectedVersion: bound.version,
            runtimeConfig: config({ researcher: { agentDeploymentId: bound.id } }),
          },
          { id: bound.id },
        ),
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining("cannot bind itself") });

    await service.agentDeployments.stop(
      invocation(
        { expectedVersion: specialistDeployment.version },
        { id: specialistDeployment.id },
      ),
    );
    expect(
      deploy({ researcher: { agentDeploymentId: specialistDeployment.id } }),
    ).rejects.toMatchObject({ message: expect.stringContaining("is stopped") });
  });
});
