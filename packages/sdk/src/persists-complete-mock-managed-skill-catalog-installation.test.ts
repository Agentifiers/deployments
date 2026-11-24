import { agentManifestContentHash } from "@deployments-ai/agent-manifest";
import { describe, expect, it } from "bun:test";
import {
  createMockPlatformSdk,
  MOCK_TENANCY_CONTEXT,
  MOCK_TENANCY_FIXTURE_IDS,
  PlatformRequestError,
} from "./index.ts";

const _ORGANIZATION_ID = MOCK_TENANCY_FIXTURE_IDS.organization;
const _PROJECT_ID = MOCK_TENANCY_FIXTURE_IDS.project;
const _SERVICE_ACCOUNT_ID = MOCK_TENANCY_FIXTURE_IDS.serviceAccount;
const _API_CREDENTIAL_ID = MOCK_TENANCY_FIXTURE_IDS.apiCredential;

describe("platform SDK mock transport", () => {
  it("persists the complete mock managed-skill catalog and installation lifecycle", async () => {
    const sdk = createMockPlatformSdk({ now: () => new Date("2026-07-20T00:00:00.000Z") });
    const context = MOCK_TENANCY_CONTEXT;
    const createdSource = await sdk.request<Record<string, unknown>>({
      method: "POST",
      path: "/v1/managed-skill-sources",
      body: {
        key: "release-tools",
        licenseHash: `sha256:${"a".repeat(64)}`,
        metadata: { channel: "stable" },
        name: "Release tools",
        pinnedCommit: "b".repeat(40),
        repositoryUrl: "https://github.com/example/release-tools",
      },
      idempotencyKey: "idem_mock_skill_source_create",
    });
    const sourceId = String(createdSource.data.id);
    const listedSources = await sdk.request<{ items: Array<Record<string, unknown>> }>({
      method: "GET",
      path: "/v1/managed-skill-sources",
    });
    const fetchedSource = await sdk.request<Record<string, unknown>>({
      method: "GET",
      path: `/v1/managed-skill-sources/${sourceId}`,
    });
    const updatedSource = await sdk.request<Record<string, unknown>>({
      method: "PATCH",
      path: `/v1/managed-skill-sources/${sourceId}`,
      body: {
        expectedVersion: 0,
        licenseHash: null,
        metadata: null,
        name: "Updated release tools",
        pinnedCommit: null,
        repositoryUrl: null,
      },
      idempotencyKey: "idem_mock_skill_source_update",
    });
    const published = await sdk.request<Record<string, unknown>>({
      method: "POST",
      path: `/v1/managed-skill-sources/${sourceId}/releases`,
      body: {
        expectedSourceVersion: 1,
        manifest: { channel: "stable" },
        releaseVersion: "1.0.0",
        skills: [
          { content: "# Verify", key: "verify" },
          {
            content: "# Deploy",
            dependencies: ["verify"],
            key: "deploy",
            references: { "references/checklist.md": "- verify\n- deploy\n" },
          },
        ],
      },
      idempotencyKey: "idem_mock_skill_release_publish",
    });
    const releaseId = String(published.data.id);
    const listedReleases = await sdk.request<{ items: Array<Record<string, unknown>> }>({
      method: "GET",
      path: `/v1/managed-skill-sources/${sourceId}/releases`,
    });
    const fetchedRelease = await sdk.request<Record<string, unknown>>({
      method: "GET",
      path: `/v1/managed-skill-releases/${releaseId}`,
    });
    const listedSkills = await sdk.request<{ items: Array<Record<string, unknown>> }>({
      method: "GET",
      path: `/v1/managed-skill-releases/${releaseId}/skills`,
    });
    const verify = listedSkills.data.items.find((skill) => skill.key === "verify")!;
    const deploy = listedSkills.data.items.find((skill) => skill.key === "deploy")!;
    const fetchedSkill = await sdk.request<Record<string, unknown>>({
      method: "GET",
      path: `/v1/managed-skills/${String(deploy.id)}`,
    });
    const installed = await sdk.request<Record<string, unknown>>({
      method: "POST",
      path: "/v1/managed-skill-installations",
      context,
      body: {
        managedSkillId: deploy.id,
        managedSkillReleaseId: releaseId,
      },
      idempotencyKey: "idem_mock_skill_install",
    });
    const installationId = String(installed.data.id);
    const listedInstallations = await sdk.request<{ items: Array<Record<string, unknown>> }>({
      method: "GET",
      path: "/v1/managed-skill-installations",
      context,
    });
    const fetchedInstallation = await sdk.request<Record<string, unknown>>({
      method: "GET",
      path: `/v1/managed-skill-installations/${installationId}`,
      context,
    });
    const removed = await sdk.request<Record<string, unknown>>({
      method: "DELETE",
      path: `/v1/managed-skill-installations/${installationId}`,
      context,
      body: { expectedVersion: 0 },
      idempotencyKey: "idem_mock_skill_remove",
    });
    expect(
      sdk.request<Record<string, unknown>>({
        method: "DELETE",
        path: `/v1/managed-skill-installations/${installationId}`,
        context,
        body: { expectedVersion: 1 },
        idempotencyKey: "idem_mock_skill_remove_again",
      }),
    ).rejects.toThrow("Managed skill installation is not active.");
    const archivedRelease = await sdk.request<Record<string, unknown>>({
      method: "DELETE",
      path: `/v1/managed-skill-releases/${releaseId}`,
      body: { expectedVersion: 0 },
      idempotencyKey: "idem_mock_skill_release_archive",
    });
    const archivedSource = await sdk.request<Record<string, unknown>>({
      method: "DELETE",
      path: `/v1/managed-skill-sources/${sourceId}`,
      body: { expectedVersion: 2 },
      idempotencyKey: "idem_mock_skill_source_archive",
    });

    expect(listedSources.data.items).toContainEqual(
      expect.objectContaining({ id: sourceId, version: 0 }),
    );
    expect(fetchedSource.data).toEqual(createdSource.data);
    expect(updatedSource.data).toMatchObject({ name: "Updated release tools", version: 1 });
    expect(updatedSource.data).not.toHaveProperty("licenseHash");
    expect(updatedSource.data).not.toHaveProperty("metadata");
    expect(updatedSource.data).not.toHaveProperty("pinnedCommit");
    expect(updatedSource.data).not.toHaveProperty("repositoryUrl");
    expect(published.data).toMatchObject({
      releaseVersion: "1.0.0",
      skillCount: 2,
      sourceId,
      version: 0,
    });
    expect(String(published.data.contentHash)).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(listedReleases.data.items).toContainEqual(
      expect.objectContaining({ id: releaseId, sourceId }),
    );
    expect(fetchedRelease.data).toEqual(published.data);
    expect(deploy.dependencies).toEqual([verify.id]);
    expect(deploy.referencePaths).toEqual(["references/checklist.md"]);
    expect(fetchedSkill.data).toMatchObject({ content: "# Deploy", id: deploy.id });
    expect(fetchedSkill.data).not.toHaveProperty("references");
    expect(installed.data).toMatchObject({
      environmentId: context.environmentId,
      managedSkillId: deploy.id,
      managedSkillReleaseId: releaseId,
      status: "active",
      version: 0,
    });
    expect(listedInstallations.data.items).toContainEqual(
      expect.objectContaining({ id: installationId }),
    );
    expect(fetchedInstallation.data).toEqual(installed.data);
    expect(removed.data).toMatchObject({ status: "removed", version: 1 });
    expect(archivedRelease.data).toMatchObject({ status: "archived", version: 1 });
    expect(archivedSource.data).toMatchObject({ status: "archived", version: 3 });
  });

  it("publishes the current mock definition draft", async () => {
    const sdk = createMockPlatformSdk({ now: () => new Date("2026-07-20T00:00:00.000Z") });
    const context = MOCK_TENANCY_CONTEXT;
    const manifest = {
      apiVersion: "agents.deployments.ai/v1",
      kind: "Agent",
      metadata: { key: "custom.agent", name: "Custom Agent", version: "1.0.0" },
      spec: {
        capabilities: {
          tools: [{ authorization: "none", name: "lookup", required: false, requiredScopes: [] }],
        },
        instructions: "Use the custom behavior.",
        model: { id: "openrouter/default" },
        runtime: {
          toolRequests: [
            {
              effect: "read",
              idempotencyKey: "lookup-on-start",
              input: { z: 1, ["\u00e4"]: 2 },
              inputSummary: "Load initial context.",
              requiredScopes: [],
              toolName: "lookup",
            },
          ],
        },
        sandbox: { mode: "none" },
      },
    };
    const created = await sdk.request<Record<string, unknown>>({
      method: "POST",
      path: "/v1/agent-definitions",
      context,
      body: { manifest },
      idempotencyKey: "idem_create_custom_agent",
    });
    const replayedCreate = await sdk.request<Record<string, unknown>>({
      method: "POST",
      path: "/v1/agent-definitions",
      context,
      body: { manifest },
      idempotencyKey: "idem_create_custom_agent",
    });
    expect(replayedCreate.data).toEqual(created.data);
    const firstDefinitionPage = await sdk.request<{
      items: Array<Record<string, unknown>>;
      nextCursor: string | null;
    }>({
      method: "GET",
      path: "/v1/agent-definitions",
      context,
      query: { limit: 1 },
    });
    expect(firstDefinitionPage.data.items).toHaveLength(1);
    expect(firstDefinitionPage.data.nextCursor).toBeString();
    const secondDefinitionPage = await sdk.request<{
      items: Array<Record<string, unknown>>;
      nextCursor: string | null;
    }>({
      method: "GET",
      path: "/v1/agent-definitions",
      context,
      query: { cursor: firstDefinitionPage.data.nextCursor!, limit: 1 },
    });
    expect(secondDefinitionPage.data.items).toHaveLength(1);
    expect(secondDefinitionPage.data.items[0]?.id).not.toBe(firstDefinitionPage.data.items[0]?.id);
    expect(
      sdk.request({
        method: "POST",
        path: "/v1/agent-definitions",
        context,
        body: { manifest: { ...manifest, metadata: { ...manifest.metadata, name: "Changed" } } },
        idempotencyKey: "idem_create_custom_agent",
      }),
    ).rejects.toBeInstanceOf(PlatformRequestError);
    const definitionId = String(created.data.id);
    const updatedManifest = {
      ...manifest,
      metadata: { ...manifest.metadata, version: "1.1.0" },
      spec: { ...manifest.spec, instructions: "Use the updated custom behavior." },
    };
    await sdk.request({
      method: "PATCH",
      path: `/v1/agent-definitions/${definitionId}`,
      context,
      body: { expectedVersion: 0, manifest: updatedManifest },
      idempotencyKey: "idem_update_custom_agent",
    });
    const published = await sdk.request<Record<string, unknown>>({
      method: "POST",
      path: `/v1/agent-definitions/${definitionId}/releases`,
      context,
      body: { expectedDefinitionVersion: 1 },
      idempotencyKey: "idem_publish_custom_agent",
    });
    expect(published.data).toMatchObject({
      agentDefinitionId: definitionId,
      manifest: updatedManifest,
      releaseNumber: 1,
    });
    expect(published.data.contentHash).toBe(agentManifestContentHash(updatedManifest));
    const replayedPublish = await sdk.request<Record<string, unknown>>({
      method: "POST",
      path: `/v1/agent-definitions/${definitionId}/releases`,
      context,
      body: { expectedDefinitionVersion: 1 },
      idempotencyKey: "idem_publish_custom_agent",
    });
    expect(replayedPublish.data).toEqual(published.data);

    expect(
      sdk.request({
        method: "POST",
        path: `/v1/agent-definitions/${definitionId}/releases`,
        context,
        body: { expectedDefinitionVersion: 1 },
        idempotencyKey: "idem_publish_custom_agent_stale",
      }),
    ).rejects.toBeInstanceOf(PlatformRequestError);

    const secondPublished = await sdk.request<Record<string, unknown>>({
      method: "POST",
      path: `/v1/agent-definitions/${definitionId}/releases`,
      context,
      body: { expectedDefinitionVersion: 2 },
      idempotencyKey: "idem_publish_custom_agent_again",
    });
    expect(secondPublished.data).toMatchObject({
      agentDefinitionId: definitionId,
      releaseNumber: 2,
    });
    expect(secondPublished.data.id).not.toBe(published.data.id);
    const firstReleasePage = await sdk.request<{
      items: Array<Record<string, unknown>>;
      nextCursor: string | null;
    }>({
      method: "GET",
      path: `/v1/agent-definitions/${definitionId}/releases`,
      context,
      query: { limit: 1 },
    });
    expect(firstReleasePage.data.items).toHaveLength(1);
    expect(firstReleasePage.data.nextCursor).toBeString();
    const secondReleasePage = await sdk.request<{ items: Array<Record<string, unknown>> }>({
      method: "GET",
      path: `/v1/agent-definitions/${definitionId}/releases`,
      context,
      query: { cursor: firstReleasePage.data.nextCursor!, limit: 1 },
    });
    expect(secondReleasePage.data.items).toHaveLength(1);
  });

  it("enforces environment-scoped definition key uniqueness", async () => {
    const sdk = createMockPlatformSdk({ now: () => new Date("2026-07-20T00:00:00.000Z") });
    const manifest = {
      apiVersion: "agents.deployments.ai/v1",
      kind: "Agent",
      metadata: { key: "unique.agent", name: "Unique Agent", version: "1.0.0" },
      spec: {
        instructions: "Keep the definition key unique.",
        model: { id: "openrouter/default" },
        sandbox: { mode: "none" },
      },
    };
    await sdk.request({
      method: "POST",
      path: "/v1/agent-definitions",
      context: MOCK_TENANCY_CONTEXT,
      body: { manifest },
      idempotencyKey: "idem_create_unique_agent",
    });
    expect(
      sdk.request({
        method: "POST",
        path: "/v1/agent-definitions",
        context: MOCK_TENANCY_CONTEXT,
        body: { manifest },
        idempotencyKey: "idem_create_duplicate_agent",
      }),
    ).rejects.toBeInstanceOf(PlatformRequestError);
    const other = await sdk.request<Record<string, unknown>>({
      method: "POST",
      path: "/v1/agent-definitions",
      context: MOCK_TENANCY_CONTEXT,
      body: {
        manifest: {
          ...manifest,
          metadata: { ...manifest.metadata, key: "other.agent", name: "Other Agent" },
        },
      },
      idempotencyKey: "idem_create_other_agent",
    });
    expect(
      sdk.request({
        method: "PATCH",
        path: `/v1/agent-definitions/${String(other.data.id)}`,
        context: MOCK_TENANCY_CONTEXT,
        body: { expectedVersion: 0, manifest },
        idempotencyKey: "idem_update_duplicate_agent",
      }),
    ).rejects.toBeInstanceOf(PlatformRequestError);
  });

  it("keeps fixture reads side-effect free and serializes concurrent publications", async () => {
    const fixtureSdk = createMockPlatformSdk({
      now: () => new Date("2026-07-20T00:00:00.000Z"),
    });
    await fixtureSdk.request({
      method: "GET",
      path: `/v1/agent-releases/${MOCK_TENANCY_FIXTURE_IDS.agentRelease}`,
      context: MOCK_TENANCY_CONTEXT,
    });
    const listedFixtureReleases = await fixtureSdk.request<{
      items: Array<Record<string, unknown>>;
    }>({
      method: "GET",
      path: `/v1/agent-definitions/${MOCK_TENANCY_FIXTURE_IDS.agentDefinition}/releases`,
      context: MOCK_TENANCY_CONTEXT,
    });
    expect(listedFixtureReleases.data.items).toContainEqual(
      expect.objectContaining({ id: MOCK_TENANCY_FIXTURE_IDS.agentRelease, releaseNumber: 1 }),
    );
    const firstFixtureRelease = await fixtureSdk.request<Record<string, unknown>>({
      method: "POST",
      path: `/v1/agent-definitions/${MOCK_TENANCY_FIXTURE_IDS.agentDefinition}/releases`,
      context: MOCK_TENANCY_CONTEXT,
      body: { expectedDefinitionVersion: 0 },
      idempotencyKey: "idem_publish_fixture_after_read",
    });
    expect(firstFixtureRelease.data).toMatchObject({
      id: MOCK_TENANCY_FIXTURE_IDS.agentRelease,
      releaseNumber: 1,
    });

    const sdk = createMockPlatformSdk({ now: () => new Date("2026-07-20T00:00:00.000Z") });
    const manifest = {
      apiVersion: "agents.deployments.ai/v1",
      kind: "Agent",
      metadata: { key: "concurrent.agent", name: "Concurrent Agent", version: "1.0.0" },
      spec: {
        instructions: "Publish exactly once per version.",
        model: { id: "openrouter/default" },
        sandbox: { mode: "none" },
      },
    };
    const definition = await sdk.request<Record<string, unknown>>({
      method: "POST",
      path: "/v1/agent-definitions",
      context: MOCK_TENANCY_CONTEXT,
      body: { manifest },
      idempotencyKey: "idem_create_concurrent_agent",
    });
    const definitionId = String(definition.data.id);
    const publications = await Promise.allSettled([
      sdk.request({
        method: "POST",
        path: `/v1/agent-definitions/${definitionId}/releases`,
        context: MOCK_TENANCY_CONTEXT,
        body: { expectedDefinitionVersion: 0 },
        idempotencyKey: "idem_publish_concurrent_agent_a",
      }),
      sdk.request({
        method: "POST",
        path: `/v1/agent-definitions/${definitionId}/releases`,
        context: MOCK_TENANCY_CONTEXT,
        body: { expectedDefinitionVersion: 0 },
        idempotencyKey: "idem_publish_concurrent_agent_b",
      }),
    ]);
    expect(publications.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(publications.filter((result) => result.status === "rejected")).toHaveLength(1);
    const releases = await sdk.request<{ items: Array<Record<string, unknown>> }>({
      method: "GET",
      path: `/v1/agent-definitions/${definitionId}/releases`,
      context: MOCK_TENANCY_CONTEXT,
    });
    expect(releases.data.items).toHaveLength(1);
    expect(releases.data.items[0]).toMatchObject({ releaseNumber: 1 });
  });

  it("validates mock deployment bindings against the pinned release", async () => {
    const sdk = createMockPlatformSdk({ now: () => new Date("2026-07-20T00:00:00.000Z") });
    const context = MOCK_TENANCY_CONTEXT;
    const manifest = {
      apiVersion: "agents.deployments.ai/v1",
      kind: "Agent",
      metadata: { key: "bound.agent", name: "Bound Agent", version: "1.0.0" },
      spec: {
        capabilities: {
          tools: [
            {
              authorization: "workspace",
              name: "records.read",
              required: true,
              requiredScopes: [],
            },
          ],
        },
        instructions: "Use the configured records tool.",
        model: { id: "openrouter/default" },
        sandbox: { mode: "none" },
      },
    };
    const definition = await sdk.request<Record<string, unknown>>({
      method: "POST",
      path: "/v1/agent-definitions",
      context,
      body: { manifest },
      idempotencyKey: "idem_create_bound_agent",
    });
    const release = await sdk.request<Record<string, unknown>>({
      method: "POST",
      path: `/v1/agent-definitions/${String(definition.data.id)}/releases`,
      context,
      body: { expectedDefinitionVersion: 0 },
      idempotencyKey: "idem_publish_bound_agent",
    });
    const agentReleaseId = String(release.data.id);
    expect(
      sdk.request({
        method: "POST",
        path: "/v1/agent-deployments",
        context,
        body: { agentReleaseId },
        idempotencyKey: "idem_create_unbound_deployment",
      }),
    ).rejects.toBeInstanceOf(PlatformRequestError);

    const deployment = await sdk.request<Record<string, unknown>>({
      method: "POST",
      path: "/v1/agent-deployments",
      context,
      body: {
        agentReleaseId,
        runtimeConfig: {
          apiVersion: "agents.deployments.ai/v1",
          kind: "AgentDeploymentConfig",
          toolAuthorizations: {
            "records.read": { authorizationId: MOCK_TENANCY_FIXTURE_IDS.serviceAccount },
          },
        },
      },
      idempotencyKey: "idem_create_bound_deployment",
    });
    expect(
      sdk.request({
        method: "PATCH",
        path: `/v1/agent-deployments/${String(deployment.data.id)}`,
        context,
        body: {
          expectedVersion: 0,
          runtimeConfig: {
            apiVersion: "agents.deployments.ai/v1",
            kind: "AgentDeploymentConfig",
            toolAuthorizations: {
              "other.read": { authorizationId: MOCK_TENANCY_FIXTURE_IDS.serviceAccount },
            },
          },
        },
        idempotencyKey: "idem_update_invalid_bound_deployment",
      }),
    ).rejects.toBeInstanceOf(PlatformRequestError);
  });

  it("isolates mock agent state by environment and keeps archives terminal", async () => {
    const sdk = createMockPlatformSdk({ now: () => new Date("2026-07-20T00:00:00.000Z") });
    const manifest = {
      apiVersion: "agents.deployments.ai/v1",
      kind: "Agent",
      metadata: { key: "scoped.agent", name: "Scoped Agent", version: "1.0.0" },
      spec: {
        instructions: "Remain scoped to one environment.",
        model: { id: "openrouter/default" },
        sandbox: { mode: "none" },
      },
    };
    const staleParentContext = {
      environmentId: MOCK_TENANCY_CONTEXT.environmentId,
      organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
      projectId: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
    };
    const created = await sdk.request<Record<string, unknown>>({
      method: "POST",
      path: "/v1/agent-definitions",
      context: staleParentContext,
      body: { manifest },
      idempotencyKey: "idem_create_scoped_agent",
    });
    expect(created.data).toMatchObject({
      environmentId: MOCK_TENANCY_CONTEXT.environmentId,
      organizationId: MOCK_TENANCY_CONTEXT.organizationId,
      projectId: MOCK_TENANCY_CONTEXT.projectId,
    });
    const definitionId = String(created.data.id);
    const otherEnvironment = {
      ...MOCK_TENANCY_CONTEXT,
      environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FB2",
    };
    for (const [path, id] of [
      ["/v1/agent-definitions", MOCK_TENANCY_FIXTURE_IDS.agentDefinition],
      ["/v1/agent-releases", MOCK_TENANCY_FIXTURE_IDS.agentRelease],
      ["/v1/agent-deployments", MOCK_TENANCY_FIXTURE_IDS.agentDeployment],
    ] as const) {
      expect(
        sdk.request({ method: "GET", path: `${path}/${id}`, context: otherEnvironment }),
      ).rejects.toBeInstanceOf(PlatformRequestError);
    }
    expect(
      sdk.request({
        method: "GET",
        path: `/v1/agent-definitions/${definitionId}`,
        context: otherEnvironment,
      }),
    ).rejects.toBeInstanceOf(PlatformRequestError);
    const otherDefinitions = await sdk.request<{ items: Array<Record<string, unknown>> }>({
      method: "GET",
      path: "/v1/agent-definitions",
      context: otherEnvironment,
    });
    expect(otherDefinitions.data.items.some((item) => item.id === definitionId)).toBe(false);

    const archived = await sdk.request<Record<string, unknown>>({
      method: "DELETE",
      path: `/v1/agent-definitions/${definitionId}`,
      context: MOCK_TENANCY_CONTEXT,
      body: { expectedVersion: 0 },
      idempotencyKey: "idem_archive_scoped_agent",
    });
    expect(archived.data).toMatchObject({ status: "archived", version: 1 });
    expect(
      sdk.request({
        method: "PATCH",
        path: `/v1/agent-definitions/${definitionId}`,
        context: MOCK_TENANCY_CONTEXT,
        body: { expectedVersion: 1, manifest },
        idempotencyKey: "idem_update_archived_agent",
      }),
    ).rejects.toBeInstanceOf(PlatformRequestError);
  });
});
