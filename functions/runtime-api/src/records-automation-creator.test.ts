import { describe, expect, test } from "bun:test";
import { handleAutomationRoutes } from "./automation-routes.ts";
import {
  deployment,
  deploymentId,
  environmentId,
  ids,
  memoryDatabase,
  now,
  organizationId,
  principal,
  projectId,
  release,
} from "./runtime-lifecycle.fixture.ts";
import type { RuntimeApiDependencies, RuntimeApiPrincipal } from "./runtime-support.ts";

const human = {
  kind: "human",
  organizationRole: "owner",
  platformAdministrator: false,
  principalId: ids[20]!,
  scope: { environmentId, organizationId, projectId },
  scopes: ["schedules:write"],
} as RuntimeApiPrincipal;
const serviceAccount: RuntimeApiPrincipal = { ...principal(), kind: "api-credential" };

async function create(
  path: "/v1/heartbeats" | "/v1/schedules",
  body: Readonly<Record<string, unknown>>,
  caller: RuntimeApiPrincipal,
) {
  const memory = memoryDatabase([deployment(), release()]);
  let nextId = 10;
  const dependencies = {
    database: memory.database,
    generateId: async () => ids[nextId++]!,
    now: () => now,
    timerProvider: { delete: async () => {}, upsert: async () => {} },
  } as unknown as RuntimeApiDependencies;
  const result = await handleAutomationRoutes({
    body: { agentDeploymentId: deploymentId, ...body },
    dependencies,
    event: { headers: { "idempotency-key": "create-automation" }, rawPath: path },
    method: "POST",
    path,
    principal: caller,
  });
  const itemType = path === "/v1/schedules" ? "schedule" : "heartbeat";
  const record = [...memory.records.values()].find((item) => item.itemType === itemType);
  return {
    createdBy: (record?.data as { readonly createdBy?: unknown } | undefined)?.createdBy,
    statusCode: result?.statusCode,
  };
}

const schedule = { expression: "rate(1 hour)", name: "Hourly check", prompt: "Check in." };
const heartbeat = { instructions: "Check in.", intervalMs: 300_000 };

describe("automation creation through the API", () => {
  test("a schedule records the person or service account that created it", async () => {
    expect(await create("/v1/schedules", schedule, human)).toEqual({
      createdBy: { id: "01ARZ3NDEKTSV4RRFFQ69G5020", type: "principal" },
      statusCode: 201,
    });
    expect(await create("/v1/schedules", schedule, serviceAccount)).toEqual({
      createdBy: { id: "01ARZ3NDEKTSV4RRFFQ69G5003", type: "service-account" },
      statusCode: 201,
    });
  });

  test("a heartbeat records the person or service account that created it", async () => {
    expect(await create("/v1/heartbeats", heartbeat, human)).toEqual({
      createdBy: { id: "01ARZ3NDEKTSV4RRFFQ69G5020", type: "principal" },
      statusCode: 201,
    });
    expect(await create("/v1/heartbeats", heartbeat, serviceAccount)).toEqual({
      createdBy: { id: "01ARZ3NDEKTSV4RRFFQ69G5003", type: "service-account" },
      statusCode: 201,
    });
  });
});
