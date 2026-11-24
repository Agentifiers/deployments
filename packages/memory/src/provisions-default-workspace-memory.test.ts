import { describe, expect, it } from "bun:test";
import { completedFlushRun, fixedNow, memoryDatabase } from "./memory-flush-test-fixtures.ts";
import { makeMemoryPlatform } from "./platform.ts";
import { ids } from "./test-fixtures.ts";
import { fakeMemorySearchProvider } from "./memory-search-test-fixtures.ts";

const workspaceScope = {
  environmentId: ids.environment,
  organizationId: ids.organization,
  projectId: ids.project,
  workspaceId: ids.workspace,
};
const environmentScope = {
  environmentId: ids.environment,
  organizationId: ids.organization,
  projectId: ids.project,
};

function setup(memory: { readonly reviewMode?: "manual" } = {}) {
  const { database, put } = memoryDatabase();
  const platform = makeMemoryPlatform({
    database,
    embedding: async () => ({ embedding: [0.1, 0.2, 0.3], model: "test", provider: "test" }),
    now: () => fixedNow,
    searchProvider: fakeMemorySearchProvider().provider,
  });
  const run = completedFlushRun(put, workspaceScope, ids.run, { mode: "workspace", ...memory });
  return { platform, run };
}

describe("default workspace memory", () => {
  it("gives a workspace-memory agent's first run a space, grant, and recall policy to flush into", async () => {
    const { platform, run } = setup();
    expect(
      platform.enqueueFlush(workspaceScope, run, { memoryMode: "workspace" }),
    ).rejects.toMatchObject({
      code: "memory_space_required",
    });

    expect(await platform.provisionDefaultWorkspaceMemory(environmentScope, run)).toBe(true);
    expect(await platform.provisionDefaultWorkspaceMemory(environmentScope, run)).toBe(true);

    const spaces = await platform.listMemorySpaces(environmentScope);
    expect(spaces.map((space) => space.data)).toEqual([
      expect.objectContaining({ isDefault: true, kind: "workspace", workspaceId: ids.workspace }),
    ]);
    const grants = await platform.listMemorySpaceGrants(workspaceScope, { consistent: true });
    expect(grants.map((grant) => grant.data)).toEqual([
      expect.objectContaining({
        agentDefinitionId: ids.agent,
        memorySpaceId: spaces[0]!.data.id,
        permission: "read-write",
        workspaceId: ids.workspace,
      }),
    ]);
    expect((await platform.effectivePolicy(workspaceScope))?.data).toMatchObject({
      activeRecallEnabled: true,
      scope: "workspace",
      workspaceId: ids.workspace,
    });
    const flush = await platform.enqueueFlush(workspaceScope, run, { memoryMode: "workspace" });
    expect(flush.data).toMatchObject({
      memorySpaceId: spaces[0]!.data.id,
      reviewMode: "auto-approve",
    });
  });

  it("approves flushes into the default space only while the manifest leaves review unset", async () => {
    const manual = setup({ reviewMode: "manual" });
    await manual.platform.provisionDefaultWorkspaceMemory(environmentScope, manual.run);
    const manualFlush = await manual.platform.enqueueFlush(workspaceScope, manual.run, {
      memoryMode: "workspace",
    });
    expect(manualFlush.data.reviewMode).toBe("manual");

    const administered = setup();
    const space = await administered.platform.createMemorySpace(workspaceScope, {
      name: "Team notes",
    });
    await administered.platform.grantMemorySpace(workspaceScope, {
      agentDefinitionId: ids.agent,
      memorySpaceId: space.data.id,
      permission: "read-write",
    });
    const administeredFlush = await administered.platform.enqueueFlush(
      workspaceScope,
      administered.run,
      { memoryMode: "workspace" },
    );
    expect(administeredFlush.data).toMatchObject({
      memorySpaceId: space.data.id,
      reviewMode: "manual",
    });
  });

  it("keeps an administrator's recall-off policy and revoked grant", async () => {
    const { platform, run } = setup();
    await platform.upsertPolicy(environmentScope, { activeRecallEnabled: false });
    expect(await platform.provisionDefaultWorkspaceMemory(environmentScope, run)).toBe(true);
    expect((await platform.effectivePolicy(workspaceScope))?.data).toMatchObject({
      activeRecallEnabled: false,
      scope: "environment",
    });

    const [grant] = await platform.listMemorySpaceGrants(workspaceScope, { consistent: true });
    await platform.revokeMemorySpaceGrant(workspaceScope, grant!.data.id);
    expect(await platform.provisionDefaultWorkspaceMemory(environmentScope, run)).toBe(false);
    expect(await platform.listMemorySpaceGrants(workspaceScope, { consistent: true })).toEqual([]);
  });

  it("leaves a run outside a workspace unconfigured", async () => {
    const { platform } = setup();
    const { put } = memoryDatabase();
    const run = completedFlushRun(put, environmentScope, ids.run, { mode: "workspace" });
    expect(await platform.provisionDefaultWorkspaceMemory(environmentScope, run)).toBe(false);
    expect(await platform.listMemorySpaces(environmentScope)).toEqual([]);
  });
});
