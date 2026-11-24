import { describe, expect, test } from "bun:test";
import {
  ENVIRONMENT,
  ENVIRONMENT_ID,
  OTHER_ENVIRONMENT_ID,
  invocation,
  makeService,
  manifest,
} from "./agent-lifecycle-test-support.ts";
import type { AgentEnvironmentScope, AgentLifecyclePersistence } from "./index.ts";

const TARGET = { ...ENVIRONMENT, id: OTHER_ENVIRONMENT_ID } as AgentEnvironmentScope;
const FOREIGN_PROJECT_ENVIRONMENT = {
  ...ENVIRONMENT,
  id: "01ARZ3NDEKTSV4RRFFQ69G5FD0",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FD1",
} as AgentEnvironmentScope;

async function sourceRelease(service: AgentLifecyclePersistence) {
  const definition = await service.agentDefinitions.create(invocation({ manifest: manifest() }));
  const release = await service.agentReleases.publish(
    invocation({ expectedDefinitionVersion: 0 }, { id: definition.id }),
  );
  return { definition, release };
}

function promote(
  service: AgentLifecyclePersistence,
  releaseId: string,
  target: string = TARGET.id,
) {
  return service.agentReleases.promote(
    invocation({ targetEnvironmentId: target }, { id: releaseId }),
  );
}

describe("agent release promotion", () => {
  test("creates the target definition and an identical release without deployments", async () => {
    const { records, service } = makeService([ENVIRONMENT, TARGET]);
    const { release } = await sourceRelease(service);

    const promoted = await promote(service, release.id);

    expect(promoted.created).toBe(true);
    expect(promoted.release).toMatchObject({
      contentHash: release.contentHash,
      environmentId: TARGET.id,
      releaseNumber: 1,
      status: "active",
    });
    expect(promoted.release.id).not.toBe(release.id);
    expect(promoted.release.manifest).toEqual(release.manifest);
    const targetDefinitions = await service.agentDefinitions.list(
      invocation(undefined, { environmentId: TARGET.id }),
    );
    expect(targetDefinitions.items).toHaveLength(1);
    expect(targetDefinitions.items[0]).toMatchObject({
      id: promoted.release.agentDefinitionId,
      slug: "example.assistant",
    });
    const targetDeployments = await service.agentDeployments.list(
      invocation(undefined, { environmentId: TARGET.id }),
    );
    expect(targetDeployments.items).toHaveLength(0);
    const published = [...records.values()].find(
      (record) =>
        record.itemType === "semantic-event" &&
        record.data.eventType === "agent-release.published" &&
        record.data.environmentId === TARGET.id,
    );
    expect(published?.itemType === "semantic-event" && published.data.payload).toMatchObject({
      sourceEnvironmentId: ENVIRONMENT_ID,
      sourceReleaseId: release.id,
    });
  });

  test("returns the existing target release when promoted again", async () => {
    const { records, service } = makeService([ENVIRONMENT, TARGET]);
    const { release } = await sourceRelease(service);
    const first = await promote(service, release.id);
    const second = await promote(service, release.id);

    expect(second).toEqual({ created: false, release: first.release });
    expect(
      [...records.values()].filter(
        (record) => record.itemType === "agent-release" && record.data.environmentId === TARGET.id,
      ),
    ).toHaveLength(1);
  });

  test("imports the exact source manifest into an existing definition without touching its draft", async () => {
    const { service } = makeService([ENVIRONMENT, TARGET]);
    const { release } = await sourceRelease(service);
    const targetDefinition = await service.agentDefinitions.create(
      invocation({ manifest: manifest() }, { environmentId: TARGET.id }),
    );
    const revisedDraft = {
      ...manifest(),
      spec: { ...manifest().spec, instructions: "A different target draft." },
    };
    const updated = await service.agentDefinitions.update(
      invocation(
        { expectedVersion: 0, manifest: revisedDraft },
        { environmentId: TARGET.id, id: targetDefinition.id },
      ),
    );

    const promoted = await promote(service, release.id);

    expect(promoted.created).toBe(true);
    expect(promoted.release.agentDefinitionId).toBe(targetDefinition.id);
    expect(promoted.release.manifest.spec.instructions).toBe(release.manifest.spec.instructions);
    const after = await service.agentDefinitions.get(
      invocation(undefined, { environmentId: TARGET.id, id: targetDefinition.id }),
    );
    expect(after.draft.spec.instructions).toBe("A different target draft.");
    expect(after.version).toBe(updated.version + 1);
  });

  test("reuses an identical active release already published in the target", async () => {
    const { service } = makeService([ENVIRONMENT, TARGET]);
    const { release } = await sourceRelease(service);
    const targetDefinition = await service.agentDefinitions.create(
      invocation({ manifest: manifest() }, { environmentId: TARGET.id }),
    );
    const published = await service.agentReleases.publish(
      invocation(
        { expectedDefinitionVersion: 0 },
        { environmentId: TARGET.id, id: targetDefinition.id },
      ),
    );
    expect(published.contentHash).toBe(release.contentHash);

    expect(promote(service, release.id)).resolves.toEqual({
      created: false,
      release: published,
    });
  });

  test("rejects cross-project targets, unknown targets, and archived sources", async () => {
    const { service } = makeService([ENVIRONMENT, TARGET, FOREIGN_PROJECT_ENVIRONMENT]);
    const { release } = await sourceRelease(service);
    expect(promote(service, release.id, FOREIGN_PROJECT_ENVIRONMENT.id)).rejects.toMatchObject({
      code: "cross_project_promotion",
      kind: "unprocessable",
    });
    expect(promote(service, release.id, "01ARZ3NDEKTSV4RRFFQ69G5FD9")).rejects.toMatchObject({
      code: "target_environment_not_found",
      kind: "not-found",
    });
    expect(promote(service, release.id, ENVIRONMENT_ID)).rejects.toMatchObject({
      code: "same_environment_promotion",
    });
    await service.agentReleases.archive(invocation({ expectedVersion: 0 }, { id: release.id }));
    expect(promote(service, release.id)).rejects.toMatchObject({
      code: "source_release_archived",
    });
  });

  test("rejects archived target definitions and workspace-scoped sources", async () => {
    const { records, service } = makeService([ENVIRONMENT, TARGET]);
    const { definition, release } = await sourceRelease(service);
    const targetDefinition = await service.agentDefinitions.create(
      invocation({ manifest: manifest() }, { environmentId: TARGET.id }),
    );
    await service.agentDefinitions.archive(
      invocation({ expectedVersion: 0 }, { environmentId: TARGET.id, id: targetDefinition.id }),
    );
    expect(promote(service, release.id)).rejects.toMatchObject({
      code: "target_definition_archived",
    });

    for (const [storageKey, record] of records) {
      if (record.itemType === "agent-definition" && record.data.id === definition.id) {
        records.set(storageKey, {
          ...record,
          data: { ...record.data, workspaceId: "01ARZ3NDEKTSV4RRFFQ69G5FD5" },
        } as typeof record);
      }
    }
    expect(promote(service, release.id)).rejects.toMatchObject({
      code: "workspace_scoped_definition",
    });
  });
});
