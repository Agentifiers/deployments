import { describe, expect, it } from "bun:test";
import {
  createMockPlatformSdk,
  MOCK_TENANCY_CONTEXT,
  MOCK_TENANCY_FIXTURE_IDS,
  PlatformRequestError,
} from "./index.ts";

const ORGANIZATION_ID = MOCK_TENANCY_FIXTURE_IDS.organization;
const PROJECT_ID = MOCK_TENANCY_FIXTURE_IDS.project;
const SERVICE_ACCOUNT_ID = MOCK_TENANCY_FIXTURE_IDS.serviceAccount;
const API_CREDENTIAL_ID = MOCK_TENANCY_FIXTURE_IDS.apiCredential;

describe("platform SDK mock transport", () => {
  it("persists mock deployment lifecycle state", async () => {
    const sdk = createMockPlatformSdk({ now: () => new Date("2026-07-20T00:00:00.000Z") });
    const context = MOCK_TENANCY_CONTEXT;
    const published = await sdk.request<Record<string, unknown>>({
      method: "POST",
      path: `/v1/agent-definitions/${MOCK_TENANCY_FIXTURE_IDS.agentDefinition}/releases`,
      context,
      body: { expectedDefinitionVersion: 0 },
      idempotencyKey: "idem_publish_for_deployment",
    });
    const agentReleaseId = String(published.data.id);
    const runtimeConfig = {
      apiVersion: "agents.deployments.ai/v1",
      kind: "AgentDeploymentConfig",
    } as const;
    const created = await sdk.request<Record<string, unknown>>({
      method: "POST",
      path: "/v1/agent-deployments",
      context,
      body: { agentReleaseId, desiredState: "paused", runtimeConfig },
      idempotencyKey: "idem_create_agent_deployment",
    });
    const deploymentId = String(created.data.id);
    expect(created.data).toMatchObject({
      agentReleaseId,
      currentState: "paused",
      desiredState: "paused",
      runtimeConfig,
      version: 0,
    });

    const updated = await sdk.request<Record<string, unknown>>({
      method: "PATCH",
      path: `/v1/agent-deployments/${deploymentId}`,
      context,
      body: { desiredState: "running", expectedVersion: 0 },
      idempotencyKey: "idem_resume_agent_deployment",
    });
    expect(updated.data).toMatchObject({
      agentReleaseId,
      currentState: "ready",
      desiredState: "running",
      runtimeConfig,
      version: 1,
    });

    const fetched = await sdk.request<Record<string, unknown>>({
      method: "GET",
      path: `/v1/agent-deployments/${deploymentId}`,
      context,
    });
    expect(fetched.data).toEqual(updated.data);
    const listed = await sdk.request<{ items: Array<Record<string, unknown>> }>({
      method: "GET",
      path: "/v1/agent-deployments",
      context,
    });
    expect(listed.data.items).toContainEqual(updated.data);
    const firstDeploymentPage = await sdk.request<{
      items: Array<Record<string, unknown>>;
      nextCursor: string | null;
    }>({
      method: "GET",
      path: "/v1/agent-deployments",
      context,
      query: { limit: 1 },
    });
    expect(firstDeploymentPage.data.items).toHaveLength(1);
    expect(firstDeploymentPage.data.nextCursor).toBeString();
    const secondDeploymentPage = await sdk.request<{ items: Array<Record<string, unknown>> }>({
      method: "GET",
      path: "/v1/agent-deployments",
      context,
      query: { cursor: firstDeploymentPage.data.nextCursor!, limit: 1 },
    });
    expect(secondDeploymentPage.data.items).toHaveLength(1);

    const stopped = await sdk.request<Record<string, unknown>>({
      method: "DELETE",
      path: `/v1/agent-deployments/${deploymentId}`,
      context,
      body: { expectedVersion: 1 },
      idempotencyKey: "idem_stop_agent_deployment",
    });
    expect(stopped.data).toMatchObject({
      agentReleaseId,
      currentState: "stopped",
      desiredState: "stopped",
      runtimeConfig,
      version: 2,
    });
    expect(
      sdk.request({
        method: "PATCH",
        path: `/v1/agent-deployments/${deploymentId}`,
        context,
        body: { desiredState: "running", expectedVersion: 2 },
        idempotencyKey: "idem_restart_stopped_agent_deployment",
      }),
    ).rejects.toBeInstanceOf(PlatformRequestError);
  });

  it("requires the canned deployment to stop before archiving its release", async () => {
    const sdk = createMockPlatformSdk({ now: () => new Date("2026-07-20T00:00:00.000Z") });
    expect(
      sdk.request({
        method: "DELETE",
        path: `/v1/agent-releases/${MOCK_TENANCY_FIXTURE_IDS.agentRelease}`,
        context: MOCK_TENANCY_CONTEXT,
        body: { expectedVersion: 0 },
        idempotencyKey: "idem_archive_pinned_fixture_release",
      }),
    ).rejects.toBeInstanceOf(PlatformRequestError);
    await sdk.request({
      method: "DELETE",
      path: `/v1/agent-deployments/${MOCK_TENANCY_FIXTURE_IDS.agentDeployment}`,
      context: MOCK_TENANCY_CONTEXT,
      body: { expectedVersion: 0 },
      idempotencyKey: "idem_stop_fixture_deployment",
    });
    const archived = await sdk.request<Record<string, unknown>>({
      method: "DELETE",
      path: `/v1/agent-releases/${MOCK_TENANCY_FIXTURE_IDS.agentRelease}`,
      context: MOCK_TENANCY_CONTEXT,
      body: { expectedVersion: 0 },
      idempotencyKey: "idem_archive_unpinned_fixture_release",
    });
    expect(archived.data).toMatchObject({ status: "archived", version: 1 });
  });

  it("rejects invalid tenancy methods and identifiers in mock mode", async () => {
    const sdk = createMockPlatformSdk();
    expect(sdk.request({ method: "PATCH", path: "/v1/api-keys" })).rejects.toBeInstanceOf(
      PlatformRequestError,
    );
    expect(
      sdk.request({ method: "POST", path: `/v1/service-accounts/${SERVICE_ACCOUNT_ID}` }),
    ).rejects.toBeInstanceOf(PlatformRequestError);
    expect(sdk.request({ method: "GET", path: "/v1/projects/prj_1" })).rejects.toBeInstanceOf(
      PlatformRequestError,
    );
    expect(
      sdk.request({
        method: "GET",
        path: "/v1/projects",
        context: { organizationId: "org_1" },
      }),
    ).rejects.toBeInstanceOf(PlatformRequestError);
    expect(
      sdk.request({
        method: "POST",
        path: "/v1/api-keys",
        body: { name: "CI" },
        context: { environmentId: MOCK_TENANCY_CONTEXT.environmentId },
        idempotencyKey: "idem_invalid_api_key",
      }),
    ).rejects.toBeInstanceOf(PlatformRequestError);
    expect(
      sdk.request({
        method: "POST",
        path: "/v1/projects",
        body: { name: "Platform", slug: "Not Canonical" },
        context: { organizationId: ORGANIZATION_ID },
        idempotencyKey: "idem_invalid_project",
      }),
    ).rejects.toBeInstanceOf(PlatformRequestError);
    expect(
      sdk.request({
        method: "GET",
        path: "/v1/projects",
        context: { organizationId: ORGANIZATION_ID },
        query: { limit: 101 },
      }),
    ).rejects.toBeInstanceOf(PlatformRequestError);
    expect(
      sdk.request({
        method: "GET",
        path: "/v1/projects",
        context: { organizationId: ORGANIZATION_ID },
        query: { bogus: "x" },
      }),
    ).rejects.toBeInstanceOf(PlatformRequestError);
    expect(
      sdk.request({ method: "GET", path: `/v1/projects/${PROJECT_ID}/extra` }),
    ).rejects.toBeInstanceOf(PlatformRequestError);
    expect(
      sdk.request({ method: "POST", path: `/v1/api-keys/${API_CREDENTIAL_ID}/rotat` }),
    ).rejects.toBeInstanceOf(PlatformRequestError);
    expect(
      sdk.request({
        method: "POST",
        path: "/v1/projects",
        body: { name: "Platform" },
        context: { organizationId: ORGANIZATION_ID },
      }),
    ).rejects.toBeInstanceOf(PlatformRequestError);
    expect(
      sdk.request({
        method: "GET",
        path: `/v1/projects/${PROJECT_ID}`,
        body: { name: "Forged" },
        context: { projectId: PROJECT_ID },
      }),
    ).rejects.toBeInstanceOf(PlatformRequestError);
    expect(sdk.request({ method: "GET", path: "/v1/projects" })).rejects.toBeInstanceOf(
      PlatformRequestError,
    );
  });
});
