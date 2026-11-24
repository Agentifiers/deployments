import { describe, expect, it } from "bun:test";
import { ModelTokenIssuanceError, type ModelTokenRequest } from "@deployments-ai/model-gateway";
import {
  agentRunModelGatewayCredentials,
  inRunBrainModelCredentials,
  makeAgentRunModelTokenRegistry,
  type AgentRunModelLease,
} from "./agent-run-model-tokens.ts";
import { processAgentRun } from "./index.ts";
import { fixtures, inMemoryDatabase, workerDependencies } from "./agent-run.fixture.ts";
import { loadRun } from "./records.ts";

const lease: AgentRunModelLease = {
  leaseOwner: "worker-a",
  organizationId: "org-1",
  runId: "run-1",
  threadId: "thread-1",
};

describe("agent run model token registry", () => {
  it("registers a claim until its registration is removed", () => {
    const registry = makeAgentRunModelTokenRegistry();
    const unregister = registry.register(lease);
    expect(registry.lease(lease.runId)).toEqual(lease);
    unregister();
    expect(registry.lease(lease.runId)).toBeUndefined();
  });

  it("keeps a newer claim on the same run when an older one ends", () => {
    const registry = makeAgentRunModelTokenRegistry();
    const unregisterOld = registry.register(lease);
    registry.register({ ...lease, leaseOwner: "worker-b" });
    unregisterOld();
    expect(registry.lease(lease.runId)?.leaseOwner).toBe("worker-b");
  });
});

describe("agent run model gateway credentials", () => {
  it("requests a run token for the registered claim", async () => {
    const registry = makeAgentRunModelTokenRegistry();
    registry.register(lease);
    const requests: ModelTokenRequest[] = [];
    const credentials = agentRunModelGatewayCredentials({
      issue: async (request) => {
        requests.push(request);
        return {
          expiresAt: Date.now() / 1000 + 600,
          models: ["openai/gpt-4o"],
          token: "jwt",
        };
      },
      registry,
    });

    const token = await credentials({
      modelIds: ["openai/gpt-4o"],
      scope: { runId: "run-1" },
    });
    await credentials({
      modelIds: ["openai/gpt-4o"],
      scope: { runId: "run-1" },
    });

    expect(token).toBe("jwt");
    expect(requests).toEqual([
      {
        kind: "run",
        leaseOwner: "worker-a",
        organizationId: "org-1",
        runId: "run-1",
        threadId: "thread-1",
      },
    ]);
  });

  it("rejects a run this worker does not hold without calling the issuer", async () => {
    let issued = 0;
    const credentials = agentRunModelGatewayCredentials({
      issue: async () => {
        issued += 1;
        return { expiresAt: Date.now() / 1000 + 600, models: [], token: "jwt" };
      },
      registry: makeAgentRunModelTokenRegistry(),
    });

    expect(
      credentials({ modelIds: ["openai/gpt-4o"], scope: { runId: "run-1" } }),
    ).rejects.toBeInstanceOf(ModelTokenIssuanceError);
    expect(credentials({ modelIds: ["openai/gpt-4o"] })).rejects.toMatchObject({
      code: "lease_inactive",
    });
    expect(issued).toBe(0);
  });
});

describe("in-run Brain model gateway credentials", () => {
  it("requests one service token per route, bound to the run's claim", async () => {
    const registry = makeAgentRunModelTokenRegistry();
    registry.register(lease);
    const requests: ModelTokenRequest[] = [];
    const credentials = inRunBrainModelCredentials({
      issue: async (request) => {
        requests.push(request);
        return { expiresAt: Date.now() / 1000 + 900, models: [], token: "service-jwt" };
      },
      registry,
    });

    const token = await credentials("run-1")({
      modelIds: ["openai/gpt-4o-mini", "openrouter/z-ai/glm-5.2"],
      scope: { organizationId: "org-1" },
    });
    await credentials("run-1")({ modelIds: ["openai/gpt-4o-mini", "openrouter/z-ai/glm-5.2"] });

    expect(token).toBe("service-jwt");
    expect(requests).toEqual([
      {
        context: { organizationId: "org-1", runId: "run-1" },
        kind: "service",
        models: ["openai/gpt-4o-mini", "openrouter/z-ai/glm-5.2"],
        run: lease,
      },
    ]);
  });

  it("rejects a run this worker does not hold without calling the issuer", async () => {
    let issued = 0;
    const credentials = inRunBrainModelCredentials({
      issue: async () => {
        issued += 1;
        return { expiresAt: Date.now() / 1000 + 900, models: [], token: "service-jwt" };
      },
      registry: makeAgentRunModelTokenRegistry(),
    });

    expect(credentials("run-1")({ modelIds: ["openai/gpt-4o-mini"] })).rejects.toMatchObject({
      code: "lease_inactive",
    });
    expect(issued).toBe(0);
  });
});

describe("agent run processing", () => {
  function setup() {
    const fixture = fixtures();
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      fixture.run,
    ]);
    const registry = makeAgentRunModelTokenRegistry();
    const { dependencies } = workerDependencies(memory.database);
    return {
      dependencies: { ...dependencies, runModelTokens: registry },
      fixture,
      registry,
    };
  }

  it("registers the claimed run while it generates and removes it afterwards", async () => {
    const { dependencies, fixture, registry } = setup();
    let duringGeneration: AgentRunModelLease | undefined;
    let claimedBy: string | undefined;

    const result = await processAgentRun(fixture.queue, {
      ...dependencies,
      runtime: {
        generateAssistantMessage: async () => {
          duringGeneration = registry.lease(fixture.run.data.id);
          claimedBy = (await loadRun(dependencies.database, fixture.queue))?.data.claimedBy;
          return { assistantMessage: "done" };
        },
      },
    });

    expect(result.action).toBe("completed");
    expect(claimedBy).toBeString();
    expect(duringGeneration).toEqual({
      leaseOwner: claimedBy!,
      organizationId: fixture.run.data.organizationId,
      runId: fixture.run.data.id,
      threadId: fixture.thread.data.id,
    });
    expect(registry.lease(fixture.run.data.id)).toBeUndefined();
  });

  for (const [ending, error] of [
    ["fails", new Error("model unavailable")],
    ["is canceled", new DOMException("Agent run was canceled.", "AbortError")],
  ] as const) {
    it(`removes the claimed run when generation ${ending}`, async () => {
      const { dependencies, fixture, registry } = setup();
      let registered = false;

      await processAgentRun(fixture.queue, {
        ...dependencies,
        runtime: {
          generateAssistantMessage: async () => {
            registered = registry.lease(fixture.run.data.id) !== undefined;
            throw error;
          },
        },
      }).catch(() => undefined);

      expect(registered).toBe(true);
      expect(registry.lease(fixture.run.data.id)).toBeUndefined();
    });
  }
});
