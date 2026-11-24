import { describe, expect, it } from "bun:test";
import type { DynamoDatabaseService, HoldReason } from "@deployments-ai/db";
import { issuedModelGatewayToken, ModelTokenIssuanceError } from "@deployments-ai/model-gateway";
import { organizationHolds } from "@deployments-ai/organization-admission/testing";
import {
  inRunBrainModelCredentials,
  makeAgentRunModelTokenRegistry,
} from "./agent-run-model-tokens.ts";
import { id, inMemoryDatabase } from "./agent-run.fixture.ts";
import { issueModelToken } from "./model-token-issuer.ts";
import type { ModelServiceTokenIssuerConfig } from "./model-token-issuer-service.ts";
import {
  claimedRun,
  runRequest,
  setupClaimedRun,
  TEST_FUNDING,
  TEST_LEASE_OWNER,
  TEST_NOW,
  testIssuerDependencies,
  threadLease,
  type RunFixture,
} from "./model-token.fixture.ts";

const ANSWER_MODEL_ID = "openrouter/qwen/qwen3.7-plus";
const EMBEDDING_MODEL_ID = "openai/text-embedding-3-small";
/** Curated, so the curated defaults admit it in any environment without a policy. */
const AGENT_MODEL_ID = "openrouter/z-ai/glm-5.2";
const FUNDING = { ...TEST_FUNDING, embeddingModelIds: new Set([EMBEDDING_MODEL_ID]) };
const SUSPENDED = (organizationId: string) =>
  ({
    code: "organization_suspended",
    message: `Organization ${organizationId} is suspended.`,
    ok: false,
  }) as const;

const tenant = { environmentId: id(3), organizationId: id(1), projectId: id(2) };

const brainIssuer: ModelServiceTokenIssuerConfig = {
  kind: "service",
  service: "brain",
  serviceModels: [ANSWER_MODEL_ID, EMBEDDING_MODEL_ID],
  tenantModels: false,
};
const memoryIssuer: ModelServiceTokenIssuerConfig = {
  kind: "service",
  service: "memory",
  serviceModels: [EMBEDDING_MODEL_ID],
  tenantModels: true,
};

/** A database whose first organization standing read fails and whose later reads succeed. */
function failingFirstStandingRead(database: DynamoDatabaseService): DynamoDatabaseService {
  let failed = false;
  return {
    ...database,
    getRecord: async (table, key, consistent) => {
      if (key.sk === "ORGANIZATION-STANDING" && !failed) {
        failed = true;
        throw new Error("DynamoDB is unavailable.");
      }
      return database.getRecord(table, key, consistent);
    },
  };
}

function setupRunningRun() {
  return setupClaimedRun((fixture) => [fixture.release, claimedRun(fixture), threadLease(fixture)]);
}

describe("run tokens of a suspended organization", () => {
  async function outcomes(reasons: readonly HoldReason[]) {
    const { fixture, memory } = setupRunningRun();
    const { dependencies } = testIssuerDependencies(memory.database);
    const holds = organizationHolds(memory.database, fixture.run.data.organizationId);
    const mint = async () => {
      const response = await issueModelToken({ kind: "run" }, dependencies, runRequest(fixture));
      return response.ok ? "minted" : response.code;
    };
    for (const reason of reasons) await holds.hold(reason);
    const held = await mint();
    for (const reason of reasons) await holds.release(reason);
    return [held, await mint()];
  }

  it("keep minting for a running run under a payment hold", async () => {
    expect(await outcomes(["payment"])).toEqual(["minted", "minted"]);
  });

  it("are refused under a stopping hold until the hold is released", async () => {
    expect(await outcomes(["abuse"])).toEqual(["organization_suspended", "minted"]);
    expect(await outcomes(["payment", "abuse"])).toEqual(["organization_suspended", "minted"]);
  });

  it("fail the invocation when the standing read fails, though later reads would succeed", async () => {
    const { fixture, memory } = setupRunningRun();
    const { dependencies } = testIssuerDependencies(failingFirstStandingRead(memory.database));

    expect(issueModelToken({ kind: "run" }, dependencies, runRequest(fixture))).rejects.toThrow(
      "DynamoDB is unavailable.",
    );
  });
});

describe("service tokens of a suspended organization", () => {
  async function underHolds(
    issuer: ModelServiceTokenIssuerConfig,
    request: unknown,
    reasons: readonly HoldReason[],
  ) {
    const memory = inMemoryDatabase([]);
    const { dependencies } = testIssuerDependencies(memory.database, { funding: FUNDING });
    const holds = organizationHolds(memory.database, tenant.organizationId);
    const mint = async () => {
      const response = await issueModelToken(issuer, dependencies, request);
      return response.ok ? "minted" : response;
    };
    for (const reason of reasons) await holds.hold(reason);
    const held = await mint();
    for (const reason of reasons) await holds.release(reason);
    return [held, await mint()];
  }

  const brainApiAnswer = {
    context: { organizationId: tenant.organizationId },
    kind: "service",
    models: [ANSWER_MODEL_ID],
  };

  it("refuse a Brain API answer model under any hold and mint it after release", async () => {
    for (const reasons of [["payment"], ["abuse"]] as const) {
      expect(await underHolds(brainIssuer, brainApiAnswer, reasons)).toEqual([
        SUSPENDED(tenant.organizationId),
        "minted",
      ]);
    }
  });

  it("refuse a memory flush under a payment hold although its context names the run", async () => {
    const flush = {
      context: { agentDefinitionId: id(5), ...tenant, runId: id(6) },
      kind: "service",
      models: [AGENT_MODEL_ID],
    };

    expect(await underHolds(memoryIssuer, flush, ["payment"])).toEqual([
      SUSPENDED(tenant.organizationId),
      "minted",
    ]);
  });

  it("mint a memory search embedding under any hold, as operator-funded infrastructure", async () => {
    const memorySearch = {
      context: { organizationId: tenant.organizationId },
      kind: "service",
      models: [EMBEDDING_MODEL_ID],
    };

    expect(await underHolds(memoryIssuer, memorySearch, ["abuse"])).toEqual(["minted", "minted"]);
    expect(await underHolds(memoryIssuer, memorySearch, ["payment", "abuse"])).toEqual([
      "minted",
      "minted",
    ]);
  });

  it("refuse an embedding requested alongside a chat model under any hold", async () => {
    const searchAndAnswer = {
      context: { organizationId: tenant.organizationId },
      kind: "service",
      models: [EMBEDDING_MODEL_ID, ANSWER_MODEL_ID],
    };

    for (const reasons of [["abuse"], ["payment"]] as const) {
      expect(await underHolds(brainIssuer, searchAndAnswer, reasons)).toEqual([
        SUSPENDED(tenant.organizationId),
        "minted",
      ]);
    }
  });

  it("still mint without an organization in the context", async () => {
    expect(await underHolds(brainIssuer, { kind: "service" }, ["abuse"])).toEqual([
      "minted",
      "minted",
    ]);
  });

  it("fail the invocation when the standing read fails, though later reads would succeed", async () => {
    const memory = inMemoryDatabase([]);
    const { dependencies } = testIssuerDependencies(failingFirstStandingRead(memory.database));

    expect(issueModelToken(brainIssuer, dependencies, brainApiAnswer)).rejects.toThrow(
      "DynamoDB is unavailable.",
    );
  });
});

describe("Brain queries of a running run", () => {
  /** What the run's Brain search (embedding) and Brain answer (chat) model calls get. */
  async function outcomes(fixture: RunFixture, database: DynamoDatabaseService) {
    const { dependencies } = testIssuerDependencies(database, { funding: FUNDING });
    const registry = makeAgentRunModelTokenRegistry();
    registry.register({
      leaseOwner: TEST_LEASE_OWNER,
      organizationId: fixture.run.data.organizationId,
      runId: fixture.run.data.id,
      threadId: fixture.run.data.threadId,
    });
    const credentials = inRunBrainModelCredentials({
      issue: async (request) =>
        issuedModelGatewayToken(await issueModelToken(brainIssuer, dependencies, request)),
      now: () => TEST_NOW.getTime(),
      registry,
    })(fixture.run.data.id);
    const call = (modelId: string) =>
      credentials({
        modelIds: [modelId],
        scope: { organizationId: fixture.run.data.organizationId },
      })
        .then(() => "minted")
        .catch((cause: unknown) => (cause instanceof ModelTokenIssuanceError ? cause.code : cause));
    return { answer: await call(ANSWER_MODEL_ID), search: await call(EMBEDDING_MODEL_ID) };
  }

  async function underHold(reason: HoldReason) {
    const { fixture, memory } = setupRunningRun();
    await organizationHolds(memory.database, fixture.run.data.organizationId).hold(reason);
    return outcomes(fixture, memory.database);
  }

  it("search and answer under a payment hold while the run finishes", async () => {
    expect(await underHold("payment")).toEqual({ answer: "minted", search: "minted" });
  });

  it("are refused an answer model under a stopping hold", async () => {
    expect(await underHold("abuse")).toEqual({
      answer: "organization_suspended",
      search: "minted",
    });
  });

  it("are refused an answer model once the run no longer holds its lease", async () => {
    const { fixture, memory } = setupClaimedRun((fixture) => [
      fixture.release,
      claimedRun(fixture),
      threadLease(fixture, { expiresAt: "2026-07-22T00:00:09.000Z" }),
    ]);

    expect(await outcomes(fixture, memory.database)).toEqual({
      answer: "lease_inactive",
      search: "minted",
    });
  });

  it("are refused an answer model once the run is no longer running", async () => {
    const { fixture, memory } = setupClaimedRun((fixture) => [
      fixture.release,
      claimedRun(fixture, { status: "waiting-for-tool" }),
      threadLease(fixture),
    ]);

    expect(await outcomes(fixture, memory.database)).toEqual({
      answer: "lease_inactive",
      search: "minted",
    });
  });

  it("refuse a run claim the context does not name", async () => {
    const { fixture, memory } = setupRunningRun();
    const { dependencies } = testIssuerDependencies(memory.database);
    const run = {
      leaseOwner: TEST_LEASE_OWNER,
      organizationId: fixture.run.data.organizationId,
      runId: fixture.run.data.id,
      threadId: fixture.run.data.threadId,
    };

    expect(
      await issueModelToken(brainIssuer, dependencies, {
        context: { organizationId: run.organizationId, runId: id(9) },
        kind: "service",
        models: [ANSWER_MODEL_ID],
        run,
      }),
    ).toEqual({
      code: "invalid_request",
      message: "Service token context must name the organization and run of its run.",
      ok: false,
    });
  });
});
