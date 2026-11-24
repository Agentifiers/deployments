import { describe, expect, it } from "bun:test";
import {
  AgentDeploymentRecord,
  AgentReleaseRecord,
  withCanonicalRecordKeys,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { fixtures, id, inMemoryDatabase, workerDependencies } from "./agent-run.fixture.ts";
import { validatePins } from "./agent-run-input.ts";
import { processAgentRun } from "./agent-run.ts";

type Fixture = ReturnType<typeof fixtures>;

function movedDeployment(fixture: Fixture, data: Record<string, unknown>) {
  return Schema.decodeUnknownSync(AgentDeploymentRecord)(
    withCanonicalRecordKeys({
      data: { ...fixture.deployment.data, ...data, version: fixture.deployment.data.version + 1 },
      itemType: "agent-deployment" as const,
    }),
  );
}

function newerRelease(
  fixture: Fixture,
  agentDefinitionId = fixture.release.data.agentDefinitionId,
) {
  return Schema.decodeUnknownSync(AgentReleaseRecord)(
    withCanonicalRecordKeys({
      data: { ...fixture.release.data, agentDefinitionId, id: id(60), releaseNumber: 2 },
      itemType: "agent-release" as const,
    }),
  );
}

async function execute(fixture: Fixture, deployment: typeof fixture.deployment) {
  const memory = inMemoryDatabase([
    fixture.release,
    newerRelease(fixture),
    deployment,
    fixture.thread,
    fixture.userMessage,
    fixture.run,
  ]);
  const { dependencies } = workerDependencies(memory.database);
  // workerDependencies asserts the model request carries the run's pinned release, id(6).
  return processAgentRun(fixture.queue, dependencies);
}

describe("worker release pins across deployment lifecycle changes", () => {
  it("executes an in-flight run on its original release after the deployment is retargeted", async () => {
    const fixture = fixtures();
    const retargeted = movedDeployment(fixture, { agentReleaseId: id(60) });
    expect(execute(fixture, retargeted)).resolves.toMatchObject({ action: "completed" });
  });

  it("executes a candidate-pinned run after the canary is promoted or aborted", async () => {
    const fixture = fixtures();
    const promoted = movedDeployment(fixture, { agentReleaseId: id(60) });
    expect(execute(fixture, promoted)).resolves.toMatchObject({ action: "completed" });
    const canary = movedDeployment(fixture, {
      agentReleaseId: id(60),
      candidateAgentReleaseId: fixture.release.data.id,
      candidateStartedAt: fixture.deployment.data.createdAt,
      candidateWeight: 50,
    });
    expect(execute(fixtures(), canary)).resolves.toMatchObject({ action: "completed" });
  });

  it("still rejects a run whose release belongs to another definition", () => {
    const fixture = fixtures();
    const foreign = newerRelease(fixture, id(61));
    const run = { ...fixture.run, data: { ...fixture.run.data, agentReleaseId: foreign.data.id } };
    expect(() => validatePins(run, fixture.thread, fixture.deployment, foreign)).toThrow(
      expect.objectContaining({ code: "release_pin_mismatch" }),
    );
    expect(() => validatePins(fixture.run, fixture.thread, fixture.deployment, foreign)).toThrow(
      expect.objectContaining({ code: "release_pin_mismatch" }),
    );
  });
});
