import { describe, expect, test } from "bun:test";
import {
  Ulid,
  makeDynamoDatabase,
  makeTenancyPersistence,
  tableNamesFromEnvironment,
  withAgentLifecyclePersistence,
} from "@deployments-ai/db";
import { fakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import { humanPrincipalRecord } from "@deployments-ai/db/memory-testing";
import { Schema } from "effect";
import { createTenancyApi } from "./api-request-handlers.ts";
import { adaptTenancyPersistence } from "./tenancy-persistence-adapter.ts";

const ulid = Schema.decodeUnknownSync(Ulid);
const OWNER = ulid("01ARZ3NDEKTSV4RRFFQ69G5FA0");
const MISSING_WORKSPACE = ulid("01ARZ3NDEKTSV4RRFFQ69G5FA9");

let sequence = 0;
const nextKey = () => `workspace-definitions-${++sequence}`;

function manifest(key: string) {
  return {
    apiVersion: "agents.deployments.ai/v1",
    kind: "Agent",
    metadata: { key, name: "Support Assistant", version: "1.0.0" },
    spec: {
      instructions: "Answer support questions.",
      model: { id: "openrouter/default" },
      sandbox: { mode: "none" },
    },
  };
}

async function harness() {
  const fake = fakeDynamoDocumentClient();
  const tables = tableNamesFromEnvironment({});
  fake.put(tables.control, humanPrincipalRecord(OWNER, "owner@example.com"));
  const database = makeDynamoDatabase(fake.client, tables);
  let beforeNextTransaction: (() => Promise<void>) | undefined;
  const persistence = withAgentLifecyclePersistence(makeTenancyPersistence({ database }), {
    admitManifest: async () => [],
    database: {
      ...database,
      transactWrite: async (operations, token) => {
        const hook = beforeNextTransaction;
        beforeNextTransaction = undefined;
        await hook?.();
        return database.transactWrite(operations, token);
      },
    },
  });
  const identity = { principalId: OWNER, scopes: ["platform:*"] };
  const call = <Body>(body: Body, scope: Readonly<Record<string, string>>, id?: string) => ({
    body,
    identity,
    idempotencyKey: nextKey(),
    ...(id ? { id } : {}),
    query: {},
    scope,
  });
  const organization = await persistence.organizations.create(call({ name: "Acme" }, {}));
  const organizationId = organization.id;
  const project = await persistence.projects.create(call({ name: "Support" }, { organizationId }));
  const projectId = project.id;
  const environment = await persistence.environments.create(
    call({ name: "Production", type: "production" as const }, { organizationId, projectId }),
  );
  const environmentId = environment.id;
  const scope = { environmentId, organizationId, projectId };
  const workspace = async (slug: string) =>
    (await persistence.workspaces.create(call({ name: slug, slug }, scope))).id;
  const archiveWorkspace = (workspaceId: string) =>
    persistence.workspaces.archive(call({}, scope, workspaceId));

  const fetch = createTenancyApi({
    authenticate: async () => ({
      environmentIds: [environmentId],
      organizationIds: [organizationId],
      principalId: OWNER,
      projectIds: [projectId],
      scopes: ["agents:read", "agents:write"],
    }),
    authorize: (invocation, operationName, mutation) =>
      persistence.authorize(invocation, operationName, mutation),
    idempotency: { execute: async (input) => input.operation() },
    requestId: () => "req_test",
    service: adaptTenancyPersistence(persistence),
  });
  const send = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(
      new Request(`https://api.example${path}`, {
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headers: {
          "content-type": "application/json",
          "idempotency-key": nextKey(),
          "x-deployments-environment": environmentId,
        },
        method,
      }),
    );
    return { body: (await response.json()) as Record<string, unknown>, status: response.status };
  };
  const create = (key: string, workspaceId?: string) =>
    send("POST", "/v1/agent-definitions", {
      manifest: manifest(key),
      ...(workspaceId ? { workspaceId } : {}),
    });
  return {
    archiveWorkspace,
    beforeNextTransaction: (hook: () => Promise<void>) => {
      beforeNextTransaction = hook;
    },
    create,
    send,
    workspace,
  };
}

describe("agent definitions in workspaces", () => {
  test("creates a definition in a workspace and reports the workspace on every read", async () => {
    const api = await harness();
    const workspaceId = await api.workspace("support-team");

    const created = await api.create("support.assistant", workspaceId);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      slug: "support.assistant",
      status: "active",
      workspaceId,
    });

    const id = String(created.body.id);
    expect((await api.send("GET", `/v1/agent-definitions/${id}`)).body.workspaceId).toBe(
      workspaceId,
    );
    expect((await api.send("GET", "/v1/agent-definitions")).body.items).toEqual([
      expect.objectContaining({ id, slug: "support.assistant", workspaceId }),
    ]);

    const updated = await api.send("PATCH", `/v1/agent-definitions/${id}`, {
      expectedVersion: 0,
      manifest: manifest("support.revised"),
    });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ slug: "support.revised", version: 1, workspaceId });

    const archived = await api.send("DELETE", `/v1/agent-definitions/${id}`, {
      expectedVersion: 1,
    });
    expect(archived.status).toBe(200);
    expect(archived.body).toMatchObject({ status: "archived", version: 2, workspaceId });
  });

  test("rejects a workspace change on update", async () => {
    const api = await harness();
    const workspaceId = await api.workspace("support-team");
    const created = await api.create("support.assistant");

    const updated = await api.send("PATCH", `/v1/agent-definitions/${String(created.body.id)}`, {
      expectedVersion: 0,
      manifest: manifest("support.assistant"),
      workspaceId,
    });
    expect(updated).toMatchObject({ body: { code: "validation_failed" }, status: 422 });
    const current = await api.send("GET", `/v1/agent-definitions/${String(created.body.id)}`);
    expect(current.body).not.toHaveProperty("workspaceId");
  });

  test("keeps slugs unique per workspace and separate from environment-wide definitions", async () => {
    const api = await harness();
    const first = await api.workspace("first-team");
    const second = await api.workspace("second-team");

    expect((await api.create("support.assistant", first)).status).toBe(201);
    expect((await api.create("support.assistant", second)).status).toBe(201);
    const shared = await api.create("support.assistant");
    expect(shared.status).toBe(201);
    expect(shared.body).not.toHaveProperty("workspaceId");

    const duplicate = await api.create("support.assistant", first);
    expect(duplicate.status).toBe(409);
    expect(duplicate.body).toMatchObject({
      code: "resource_conflict",
      title: "Agent definition key is already in use, or the workspace is no longer active.",
    });
    expect((await api.create("support.assistant")).body).toMatchObject({
      code: "resource_conflict",
      title: "Agent definition key is already in use.",
      status: 409,
    });
  });

  test("rejects an unknown or archived workspace", async () => {
    const api = await harness();
    const missing = await api.create("support.assistant", MISSING_WORKSPACE);
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({
      code: "resource_not_found",
      title: "Workspace was not found.",
    });

    const workspaceId = await api.workspace("retired-team");
    await api.archiveWorkspace(workspaceId);
    const archived = await api.create("support.assistant", workspaceId);
    expect(archived.status).toBe(409);
    expect(archived.body).toMatchObject({
      code: "workspace_unavailable",
      title: "Workspace is not active.",
    });
    expect((await api.send("GET", "/v1/agent-definitions")).body.items).toEqual([]);
  });

  test("does not create a definition when the workspace is archived during the write", async () => {
    const api = await harness();
    const workspaceId = await api.workspace("support-team");
    api.beforeNextTransaction(async () => {
      await api.archiveWorkspace(workspaceId);
    });

    const created = await api.create("support.assistant", workspaceId);
    expect(created.status).toBe(409);
    expect(created.body).toMatchObject({ code: "resource_conflict" });
    expect((await api.send("GET", "/v1/agent-definitions")).body.items).toEqual([]);
  });
});
