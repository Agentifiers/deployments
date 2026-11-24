import { describe, expect, it } from "bun:test";
import {
  createMockPlatformSdk,
  MOCK_TENANCY_CONTEXT,
  MOCK_TENANCY_FIXTURE_IDS,
  type PlatformRequest,
} from "./index.ts";

const context = MOCK_TENANCY_CONTEXT;
const definitionPath = `/v1/agent-definitions/${MOCK_TENANCY_FIXTURE_IDS.agentDefinition}`;

describe("mock agent release lifecycle", () => {
  it("retargets, canaries, and promotes releases", async () => {
    const sdk = createMockPlatformSdk({ now: () => new Date("2026-07-20T00:00:00.000Z") });
    let key = 0;
    const call = (request: Omit<PlatformRequest, "context">) =>
      sdk.request<Record<string, unknown>>({
        ...request,
        context,
        ...(request.method === "GET" ? {} : { idempotencyKey: `idem_lifecycle_${key++}` }),
      });
    const first = await call({
      method: "POST",
      path: `${definitionPath}/releases`,
      body: { expectedDefinitionVersion: 0 },
    });
    const second = await call({
      method: "POST",
      path: `${definitionPath}/releases`,
      body: { expectedDefinitionVersion: 1 },
    });
    const firstId = String(first.data.id);
    const secondId = String(second.data.id);
    const created = await call({
      method: "POST",
      path: "/v1/agent-deployments",
      body: { agentReleaseId: firstId },
    });
    const deploymentPath = `/v1/agent-deployments/${String(created.data.id)}`;

    const retargeted = await call({
      method: "PATCH",
      path: deploymentPath,
      body: { agentReleaseId: secondId, expectedVersion: 0 },
    });
    expect(retargeted.data).toMatchObject({ agentReleaseId: secondId, version: 1 });

    const canary = await call({
      method: "POST",
      path: `${deploymentPath}/canary`,
      body: { candidateAgentReleaseId: firstId, expectedVersion: 1, weight: 10 },
    });
    expect(canary.data).toMatchObject({
      agentReleaseId: secondId,
      candidateAgentReleaseId: firstId,
      candidateWeight: 10,
      version: 2,
    });
    expect(
      call({
        method: "PATCH",
        path: deploymentPath,
        body: { agentReleaseId: firstId, expectedVersion: 2 },
      }),
    ).rejects.toThrow("canary_active");

    const promoted = await call({
      method: "POST",
      path: `${deploymentPath}/canary/promote`,
      body: { expectedVersion: 2 },
    });
    expect(promoted.data).toMatchObject({ agentReleaseId: firstId, version: 3 });
    expect(promoted.data.candidateAgentReleaseId).toBeUndefined();

    await call({
      method: "POST",
      path: `${deploymentPath}/canary`,
      body: { candidateAgentReleaseId: secondId, expectedVersion: 3, weight: 50 },
    });
    const aborted = await call({
      method: "POST",
      path: `${deploymentPath}/canary/abort`,
      body: { expectedVersion: 4 },
    });
    expect(aborted.data).toMatchObject({ agentReleaseId: firstId, version: 5 });
    expect(aborted.data.candidateWeight).toBeUndefined();

    const samePromotion = await call({
      method: "POST",
      path: `/v1/agent-releases/${firstId}/promote`,
      body: { targetEnvironmentId: context.environmentId },
    });
    expect(samePromotion.data.id).toBe(firstId);
    expect(
      call({
        method: "POST",
        path: `/v1/agent-releases/${firstId}/promote`,
        body: { targetEnvironmentId: "01ARZ3NDEKTSV4RRFFQ69G5FB2" },
      }),
    ).rejects.toThrow("cross_project_promotion");
  });
});
