import { describe, expect, test } from "bun:test";
import {
  GENERATED_IDS,
  invocation,
  makeService,
  manifest,
} from "./agent-lifecycle-test-support.ts";
import type { AgentLifecyclePersistence, PlatformRecord } from "./index.ts";

const READ_CONFIG = {
  apiVersion: "agents.deployments.ai/v1",
  kind: "AgentDeploymentConfig",
  toolAuthorizations: { "records.read": { authorizationId: GENERATED_IDS[19] } },
} as const;

function manifestRequiringWrite() {
  const base = manifest();
  return {
    ...base,
    spec: {
      ...base.spec,
      capabilities: {
        tools: [
          ...base.spec.capabilities.tools,
          {
            authorization: "workspace",
            name: "records.write",
            required: true,
            requiredScopes: ["records:write"],
          },
        ],
      },
    },
  } as const;
}

function controlCount(records: Map<string, PlatformRecord>, releaseId: string) {
  const control = [...records.values()].find(
    (record) =>
      record.itemType === "agent-release-control" &&
      String(record.data.agentReleaseId) === releaseId,
  );
  return control?.itemType === "agent-release-control"
    ? control.data.activeDeploymentCount
    : undefined;
}

function events(records: Map<string, PlatformRecord>, eventType: string) {
  return [...records.values()].filter(
    (record) => record.itemType === "semantic-event" && record.data.eventType === eventType,
  );
}

async function twoReleases(service: AgentLifecyclePersistence) {
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
  return { definition, deployment, first, second };
}

describe("agent deployment retarget", () => {
  test("moves the pin, transfers release control counts, and records the previous release", async () => {
    const { records, service } = makeService();
    const { deployment, first, second } = await twoReleases(service);

    const paused = await service.agentDeployments.update(
      invocation({ desiredState: "paused", expectedVersion: 0 }, { id: deployment.id }),
    );
    const retargeted = await service.agentDeployments.update(
      invocation(
        { agentReleaseId: second.id, expectedVersion: paused.version },
        { id: deployment.id },
      ),
    );

    expect(retargeted).toMatchObject({
      agentReleaseId: second.id,
      currentState: "paused",
      desiredState: "paused",
      version: 2,
    });
    expect(controlCount(records, first.id)).toBe(0);
    expect(controlCount(records, second.id)).toBe(1);
    const updated = events(records, "agent-deployment.updated").at(-1);
    expect(updated?.itemType === "semantic-event" && updated.data.payload).toMatchObject({
      agentReleaseId: second.id,
      previousAgentReleaseId: first.id,
    });
    // The previous release is no longer pinned, so it can now be archived.
    expect(
      service.agentReleases.archive(invocation({ expectedVersion: 0 }, { id: first.id })),
    ).resolves.toMatchObject({ status: "archived" });
    expect(
      service.agentReleases.archive(invocation({ expectedVersion: 0 }, { id: second.id })),
    ).rejects.toMatchObject({ code: "release_in_use" });
  });

  test("rejects releases of another definition, archived releases, and stale versions", async () => {
    const { service } = makeService();
    const { deployment, second } = await twoReleases(service);
    const other = await service.agentDefinitions.create(
      invocation({ manifest: manifest("example.other", "Other Assistant") }),
    );
    const otherRelease = await service.agentReleases.publish(
      invocation({ expectedDefinitionVersion: 0 }, { id: other.id }),
    );
    expect(
      service.agentDeployments.update(
        invocation({ agentReleaseId: otherRelease.id, expectedVersion: 0 }, { id: deployment.id }),
      ),
    ).rejects.toMatchObject({ code: "definition_mismatch", kind: "conflict" });

    await service.agentReleases.archive(invocation({ expectedVersion: 0 }, { id: second.id }));
    expect(
      service.agentDeployments.update(
        invocation({ agentReleaseId: second.id, expectedVersion: 0 }, { id: deployment.id }),
      ),
    ).rejects.toMatchObject({ code: "release_archived", kind: "conflict" });
    expect(
      service.agentDeployments.update(
        invocation({ agentReleaseId: second.id, expectedVersion: 7 }, { id: deployment.id }),
      ),
    ).rejects.toMatchObject({ code: "version_conflict" });
  });

  test("validates the resulting runtime config against the target manifest", async () => {
    const { records, service } = makeService();
    const { definition, deployment, first } = await twoReleases(service);
    const revised = await service.agentDefinitions.update(
      invocation({ expectedVersion: 2, manifest: manifestRequiringWrite() }, { id: definition.id }),
    );
    const requiresWrite = await service.agentReleases.publish(
      invocation({ expectedDefinitionVersion: revised.version }, { id: definition.id }),
    );
    expect(
      service.agentDeployments.update(
        invocation({ agentReleaseId: requiresWrite.id, expectedVersion: 0 }, { id: deployment.id }),
      ),
    ).rejects.toMatchObject({ code: "invalid_agent_deployment_config", kind: "unprocessable" });
    expect(controlCount(records, first.id)).toBe(1);

    const retargeted = await service.agentDeployments.update(
      invocation(
        {
          agentReleaseId: requiresWrite.id,
          expectedVersion: 0,
          runtimeConfig: {
            ...READ_CONFIG,
            toolAuthorizations: {
              ...READ_CONFIG.toolAuthorizations,
              "records.write": { authorizationId: GENERATED_IDS[18] },
            },
          },
        },
        { id: deployment.id },
      ),
    );
    expect(retargeted.agentReleaseId).toBe(requiresWrite.id);
  });

  test("lets exactly one of two concurrent retargets commit", async () => {
    const { records, service } = makeService();
    const { deployment, first, second } = await twoReleases(service);
    const results = await Promise.allSettled([
      service.agentDeployments.update(
        invocation({ agentReleaseId: second.id, expectedVersion: 0 }, { id: deployment.id }),
      ),
      service.agentDeployments.update(
        invocation({ desiredState: "paused", expectedVersion: 0 }, { id: deployment.id }),
      ),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "version_conflict" },
    });
    const stored = await service.agentDeployments.get(invocation(undefined, { id: deployment.id }));
    expect(stored.version).toBe(1);
    const pinned = stored.agentReleaseId === second.id ? second.id : first.id;
    expect(controlCount(records, pinned)).toBe(1);
    expect(controlCount(records, pinned === first.id ? second.id : first.id)).toBe(0);
  });
});

describe("agent deployment canary", () => {
  test("starts, blocks retarget, and promotes the candidate with count accounting", async () => {
    const { records, service } = makeService();
    const { deployment, first, second } = await twoReleases(service);
    expect(
      service.agentDeployments.startCanary(
        invocation(
          { candidateAgentReleaseId: first.id, expectedVersion: 0, weight: 10 },
          { id: deployment.id },
        ),
      ),
    ).rejects.toMatchObject({ code: "candidate_same_as_primary" });
    expect(
      service.agentDeployments.startCanary(
        invocation(
          { candidateAgentReleaseId: second.id, expectedVersion: 0, weight: 100 },
          { id: deployment.id },
        ),
      ),
    ).rejects.toMatchObject({ code: "weight_invalid", kind: "invalid-input" });
    expect(
      service.agentDeployments.promoteCanary(
        invocation({ expectedVersion: 0 }, { id: deployment.id }),
      ),
    ).rejects.toMatchObject({ code: "canary_not_active" });

    const started = await service.agentDeployments.startCanary(
      invocation(
        { candidateAgentReleaseId: second.id, expectedVersion: 0, weight: 25 },
        { id: deployment.id },
      ),
    );
    expect(started).toMatchObject({
      agentReleaseId: first.id,
      candidateAgentReleaseId: second.id,
      candidateWeight: 25,
      version: 1,
    });
    expect(started.candidateStartedAt).toBeString();
    expect([controlCount(records, first.id), controlCount(records, second.id)]).toEqual([1, 1]);
    expect(
      service.agentDeployments.startCanary(
        invocation(
          { candidateAgentReleaseId: second.id, expectedVersion: 1, weight: 50 },
          { id: deployment.id },
        ),
      ),
    ).rejects.toMatchObject({ code: "canary_already_active" });
    expect(
      service.agentDeployments.update(
        invocation({ agentReleaseId: second.id, expectedVersion: 1 }, { id: deployment.id }),
      ),
    ).rejects.toMatchObject({ code: "canary_active", kind: "conflict" });
    expect(
      service.agentReleases.archive(invocation({ expectedVersion: 0 }, { id: second.id })),
    ).rejects.toMatchObject({ code: "release_in_use" });

    const paused = await service.agentDeployments.update(
      invocation({ desiredState: "paused", expectedVersion: 1 }, { id: deployment.id }),
    );
    expect(paused.candidateAgentReleaseId).toBe(second.id);
    const promoted = await service.agentDeployments.promoteCanary(
      invocation({ expectedVersion: paused.version }, { id: deployment.id }),
    );
    expect(promoted).toMatchObject({ agentReleaseId: second.id, version: 3 });
    expect(promoted.candidateAgentReleaseId).toBeUndefined();
    expect(promoted.candidateWeight).toBeUndefined();
    expect([controlCount(records, first.id), controlCount(records, second.id)]).toEqual([0, 1]);
    expect(events(records, "agent-deployment.canary-started")).toHaveLength(1);
    const promotedEvent = events(records, "agent-deployment.canary-promoted")[0];
    expect(
      promotedEvent?.itemType === "semantic-event" && promotedEvent.data.payload,
    ).toMatchObject({ agentReleaseId: second.id, previousAgentReleaseId: first.id });
  });

  test("aborts the candidate and releases its control count; stop releases both pins", async () => {
    const { records, service } = makeService();
    const { deployment, first, second } = await twoReleases(service);
    await service.agentDeployments.startCanary(
      invocation(
        { candidateAgentReleaseId: second.id, expectedVersion: 0, weight: 50 },
        { id: deployment.id },
      ),
    );
    const aborted = await service.agentDeployments.abortCanary(
      invocation({ expectedVersion: 1 }, { id: deployment.id }),
    );
    expect(aborted).toMatchObject({ agentReleaseId: first.id, version: 2 });
    expect(aborted.candidateAgentReleaseId).toBeUndefined();
    expect([controlCount(records, first.id), controlCount(records, second.id)]).toEqual([1, 0]);

    await service.agentDeployments.startCanary(
      invocation(
        { candidateAgentReleaseId: second.id, expectedVersion: 2, weight: 50 },
        { id: deployment.id },
      ),
    );
    const stopped = await service.agentDeployments.stop(
      invocation({ expectedVersion: 3 }, { id: deployment.id }),
    );
    expect(stopped.currentState).toBe("stopped");
    expect(stopped.candidateAgentReleaseId).toBeUndefined();
    expect([controlCount(records, first.id), controlCount(records, second.id)]).toEqual([0, 0]);
  });

  test("requires the deployment config to satisfy the candidate manifest", async () => {
    const { records, service } = makeService();
    const { definition, deployment } = await twoReleases(service);
    await service.agentDefinitions.update(
      invocation({ expectedVersion: 2, manifest: manifestRequiringWrite() }, { id: definition.id }),
    );
    const requiresWrite = await service.agentReleases.publish(
      invocation({ expectedDefinitionVersion: 3 }, { id: definition.id }),
    );
    expect(
      service.agentDeployments.startCanary(
        invocation(
          { candidateAgentReleaseId: requiresWrite.id, expectedVersion: 0, weight: 5 },
          { id: deployment.id },
        ),
      ),
    ).rejects.toMatchObject({ code: "invalid_agent_deployment_config" });
    expect(controlCount(records, requiresWrite.id)).toBe(0);
  });
});
