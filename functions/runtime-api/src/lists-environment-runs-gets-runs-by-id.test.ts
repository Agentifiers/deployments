import { ListRunsResponse, RunResponse } from "@deployments-ai/api-contract/runtime";
import {
  DEFAULT_TABLE_NAMES,
  decodePlatformRecord,
  makeDynamoDatabase,
  withCanonicalRecordKeys,
} from "@deployments-ai/db";
import { fakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { handleRunThreadRoutes } from "./run-thread-routes.ts";
import type { RuntimeApiDependencies, RuntimeApiPrincipal } from "./runtime-support.ts";

// Plain strings: response IDs decode as contract PublicIds, records as database Ulids.
const ids: readonly string[] = Array.from(
  { length: 24 },
  (_, index) => `01ARZ3NDEKTSV4RRFFQ69G5${String(index).padStart(3, "0")}`,
);
const [organizationId, projectId, environmentId, otherEnvironmentId] = ids as [
  string,
  string,
  string,
  string,
];
const [deploymentA, deploymentB, bindingId, releaseA, releaseB, threadId] = ids.slice(4) as [
  string,
  string,
  string,
  string,
  string,
  string,
];
const sessionTokenSecret = "runtime-api-test-secret".repeat(2);

function principal(environment = environmentId): RuntimeApiPrincipal {
  return {
    credential: { data: { scopes: ["runs:read"] } },
    kind: "api-credential",
    scope: { environmentId: environment, organizationId, projectId },
    serviceAccount: { data: { id: ids[23]!, scopes: ["runs:read"] } },
  } as unknown as RuntimeApiPrincipal;
}

/** A platform bearer JWT holder admitted to `environment` (authentication is covered elsewhere). */
function human(environment = environmentId, scopes = ["runs:read"]): RuntimeApiPrincipal {
  return {
    kind: "human",
    organizationRole: "member",
    platformAdministrator: false,
    principalId: ids[22]!,
    scope: { environmentId: environment, organizationId, projectId },
    scopes,
  } as unknown as RuntimeApiPrincipal;
}

function runRecord(input: {
  readonly createdAt: string;
  readonly environmentId?: string;
  readonly owner: Readonly<Record<string, string>>;
  readonly runId: string;
  readonly status: "completed" | "running";
}) {
  return Effect.runPromise(
    decodePlatformRecord(
      withCanonicalRecordKeys({
        data: {
          ...input.owner,
          attempt: 0,
          captureMode: "metadata-only",
          createdAt: input.createdAt,
          environmentId: input.environmentId ?? environmentId,
          executor: "hosted",
          id: input.runId,
          idempotencyKey: `private-${input.runId}`,
          organizationId,
          priority: 50,
          projectId,
          redactionPolicyVersion: 1,
          schemaVersion: 1,
          spanId: "0123456789abcdef",
          status: input.status,
          ...(input.status === "running" ? { executionSlot: 0 } : {}),
          threadId,
          traceId: "0123456789abcdef0123456789abcdef",
          trigger: "api",
          updatedAt: input.createdAt,
          version: 1,
        },
        itemType: "run",
      }),
    ),
  );
}

const customerRun = { agentDeploymentId: deploymentA, agentReleaseId: releaseA };
const [firstRun, secondRun, evaluationRun, foreignRun] = ids.slice(10, 14) as [
  string,
  string,
  string,
  string,
];

async function routes() {
  const dynamo = fakeDynamoDocumentClient();
  const database = makeDynamoDatabase(dynamo.client);
  dynamo.put(
    DEFAULT_TABLE_NAMES.control,
    withCanonicalRecordKeys({
      data: {
        createdAt: "2026-09-01T00:00:00.000Z",
        id: organizationId,
        name: "Runtime Organization",
        slug: "runtime-organization",
        status: "active",
        updatedAt: "2026-09-01T00:00:00.000Z",
        version: 1,
      },
      itemType: "organization",
    }),
  );
  for (const run of await Promise.all([
    runRecord({
      createdAt: "2026-09-01T00:00:01.000Z",
      owner: customerRun,
      runId: firstRun,
      status: "completed",
    }),
    runRecord({
      createdAt: "2026-09-01T00:00:02.000Z",
      owner: { agentDeploymentId: deploymentB, agentReleaseId: releaseB },
      runId: secondRun,
      status: "running",
    }),
    runRecord({
      createdAt: "2026-09-01T00:00:03.000Z",
      owner: { executionBindingId: bindingId, executionPurpose: "evaluation" },
      runId: evaluationRun,
      status: "completed",
    }),
    runRecord({
      createdAt: "2026-09-01T00:00:04.000Z",
      environmentId: otherEnvironmentId,
      owner: customerRun,
      runId: foreignRun,
      status: "completed",
    }),
  ])) {
    await database.transactWrite([{ kind: "put", record: run }]);
  }
  const dependencies = { database, sessionTokenSecret } as unknown as RuntimeApiDependencies;
  const call = async (
    method: "GET" | "POST",
    path: string,
    input: {
      readonly body?: Readonly<Record<string, unknown>>;
      readonly caller?: RuntimeApiPrincipal;
      readonly query?: Readonly<Record<string, string>>;
    } = {},
  ) => {
    const result = await handleRunThreadRoutes({
      body: input.body ?? {},
      dependencies,
      event: { queryStringParameters: input.query ?? {}, rawPath: path },
      method,
      path,
      principal: input.caller ?? principal(),
    });
    expect(result?.statusCode).toBe(200);
    return JSON.parse(result!.body!) as unknown;
  };
  const list = async (...args: Parameters<typeof call>) =>
    Schema.decodeUnknownSync(ListRunsResponse)(await call(...args));
  return { call, list };
}

describe("environment run lookup", () => {
  test("lists every environment run newest first with environment-bound cursors", async () => {
    const { list } = await routes();

    const first = await list("GET", "/v1/runs", { query: { limit: "2" } });
    expect(first.runs.map((run): string => run.id)).toEqual([evaluationRun, secondRun]);
    expect(first.runs[0]).toMatchObject({
      executionBindingId: bindingId,
      executionPurpose: "evaluation",
    });
    expect(first.runs[0]).not.toHaveProperty("idempotencyKey");
    expect(first.nextCursor).toBeString();

    const second = await list("POST", "/v1/runs/search", {
      body: { cursor: first.nextCursor, limit: 2 },
    });
    expect(second.runs.map((run): string => run.id)).toEqual([firstRun]);
    expect(second.nextCursor).toBeUndefined();

    expect(
      list("GET", "/v1/runs", { query: { cursor: first.nextCursor!, status: "completed" } }),
    ).rejects.toMatchObject({ code: "invalid_cursor", status: 400 });
    expect(
      list("GET", "/v1/runs", {
        caller: principal(otherEnvironmentId),
        query: { cursor: first.nextCursor! },
      }),
    ).rejects.toMatchObject({ code: "invalid_cursor", status: 400 });
    expect(
      list("GET", "/v1/runs", {
        query: { agentDeploymentId: deploymentA, cursor: first.nextCursor! },
      }),
    ).rejects.toMatchObject({ code: "invalid_cursor", status: 400 });
  });

  test("filters the environment feed and keeps owner-scoped listings", async () => {
    const { list } = await routes();
    const listedIds = async (...args: Parameters<typeof list>) =>
      (await list(...args)).runs.map((run): string => run.id);

    expect(await listedIds("GET", "/v1/runs", { query: { status: "completed" } })).toEqual([
      evaluationRun,
      firstRun,
    ]);
    expect(await listedIds("GET", "/v1/runs", { query: { executionPurpose: "customer" } })).toEqual(
      [secondRun, firstRun],
    );
    expect(await listedIds("GET", "/v1/runs", { query: { agentReleaseId: releaseB } })).toEqual([
      secondRun,
    ]);
    expect(
      await listedIds("POST", "/v1/runs/search", {
        body: {
          createdAfter: "2026-09-01T00:00:02.000Z",
          createdBefore: "2026-09-01T00:00:03.000Z",
        },
      }),
    ).toEqual([evaluationRun, secondRun]);
    expect(await listedIds("GET", "/v1/runs", { caller: principal(otherEnvironmentId) })).toEqual([
      foreignRun,
    ]);
    expect(
      await listedIds("POST", "/v1/runs/search", { body: { executionBindingId: bindingId } }),
    ).toEqual([evaluationRun]);
    expect(
      await listedIds("GET", "/v1/runs", { query: { agentDeploymentId: deploymentA } }),
    ).toEqual([firstRun]);

    expect(
      list("GET", "/v1/runs", {
        query: { agentDeploymentId: deploymentA, executionBindingId: bindingId },
      }),
    ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
    expect(
      list("GET", "/v1/runs", { query: { createdAfter: "2026-09-01" } }),
    ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
    expect(
      list("GET", "/v1/runs", { query: { executionPurpose: "internal" } }),
    ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
  });

  test("gets a run by id only inside the caller's environment", async () => {
    const { call } = await routes();

    const run = Schema.decodeUnknownSync(RunResponse)(await call("GET", `/v1/runs/${secondRun}`));
    expect(run).toMatchObject({
      agentDeploymentId: deploymentB,
      id: secondRun,
      object: "run",
      status: "running",
    });
    expect(run).not.toHaveProperty("idempotencyKey");

    expect(call("GET", `/v1/runs/${foreignRun}`)).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
    expect(
      call("GET", `/v1/runs/${secondRun}`, { caller: principal(otherEnvironmentId) }),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });
  });

  test("serves the environment feed and run lookup to platform bearer holders", async () => {
    const { call, list } = await routes();

    const feed = await list("GET", "/v1/runs", { caller: human() });
    expect(feed.runs.map((run): string => run.id)).toEqual([evaluationRun, secondRun, firstRun]);
    const searched = await list("POST", "/v1/runs/search", {
      body: { executionPurpose: "evaluation" },
      caller: human(),
    });
    expect(searched.runs.map((run): string => run.id)).toEqual([evaluationRun]);
    expect(await call("GET", `/v1/runs/${firstRun}`, { caller: human() })).toMatchObject({
      id: firstRun,
      object: "run",
    });

    expect(
      call("GET", `/v1/runs/${firstRun}`, { caller: human(otherEnvironmentId) }),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });
    expect(
      list("GET", "/v1/runs", { caller: human(environmentId, ["threads:read"]) }),
    ).rejects.toMatchObject({ code: "insufficient_scope", status: 403 });
  });
});
