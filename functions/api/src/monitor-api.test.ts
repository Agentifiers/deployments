import {
  makeAlertHistory,
  makeDynamoDatabase,
  makeIdGenerator,
  makeMonitorPersistence,
  tableNamesFromEnvironment,
  withCanonicalRecordKeys,
  type OrganizationRole,
} from "@deployments-ai/db";
import { fakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import { describe, expect, test } from "bun:test";
import type { ApiIdentity } from "./index.ts";
import { createMonitorApiHandler } from "./monitor-api.ts";

const ORG = "01J00000000000000000000001";
const PROJECT = "01J00000000000000000000010";
const ENVIRONMENT = "01J00000000000000000000020";
const OTHER_ENVIRONMENT = "01J00000000000000000000021";
const PRINCIPAL = "01J00000000000000000000030";
const NOW = "2026-11-02T10:00:00.000Z";

function human(role: OrganizationRole, overrides: Partial<ApiIdentity> = {}): ApiIdentity {
  return {
    organizationIds: [ORG],
    organizationRole: role,
    principalId: PRINCIPAL,
    scopes: ["monitors:read", "monitors:write"],
    ...overrides,
  };
}

function setup(identity: ApiIdentity) {
  return setupWith(() => identity);
}

function setupWith(identity: () => ApiIdentity) {
  const fake = fakeDynamoDocumentClient();
  const tables = tableNamesFromEnvironment({});
  fake.put(
    tables.control,
    withCanonicalRecordKeys({
      data: {
        createdAt: NOW,
        id: ORG,
        name: "Acme",
        slug: "acme",
        status: "active",
        updatedAt: NOW,
        version: 1,
      },
      itemType: "organization" as const,
    }),
  );
  const database = makeDynamoDatabase(fake.client, tables);
  const now = () => new Date(NOW);
  const ids = makeIdGenerator();
  const handler = createMonitorApiHandler({
    authenticate: async () => identity(),
    history: makeAlertHistory({ database, now }),
    idempotency: { execute: async (input) => input.operation() },
    monitors: makeMonitorPersistence({ database, generateId: () => ids.generate(), now }),
    resolveEnvironment: async (_identity, environmentId) => ({
      id: environmentId,
      organizationId: ORG,
      projectId: PROJECT,
      status: "active",
    }),
  });
  async function send(method: string, path: string, body?: unknown) {
    const response = await handler(
      new Request(`https://api.example.com${path}`, {
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
          "x-deployments-organization": ORG,
        },
        method,
      }),
    );
    if (!response) throw new Error(`No route for ${method} ${path}`);
    return { body: (await response.json()) as Record<string, unknown>, status: response.status };
  }
  return { fake, send };
}

const runFailures = {
  condition: { kind: "run-failures", threshold: 3, windowMinutes: 15 },
  environmentId: ENVIRONMENT,
  name: "Checkout failing",
  notify: { emailPrincipalIds: [], emailRoles: ["owner"], webhooks: true },
};

describe("monitor API", () => {
  test("creates, lists, mutes, tests, and archives a monitor", async () => {
    const { send } = setup(human("admin"));
    const created = await send("POST", "/v1/monitors", runFailures);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      environmentId: ENVIRONMENT,
      projectId: PROJECT,
      state: "ok",
      status: "active",
    });
    const id = created.body.id as string;

    const listed = await send("GET", `/v1/monitors?environmentId=${ENVIRONMENT}`);
    expect((listed.body.items as unknown[]).length).toBe(1);
    expect(
      (
        (await send("GET", `/v1/monitors?environmentId=${OTHER_ENVIRONMENT}`)).body
          .items as unknown[]
      ).length,
    ).toBe(0);

    const muted = await send("PATCH", `/v1/monitors/${id}`, { mute: {} });
    expect(muted.body).toMatchObject({ status: "muted", version: 2 });
    const unmuted = await send("PATCH", `/v1/monitors/${id}`, { mute: null });
    expect(unmuted.body).toMatchObject({ status: "active" });

    const tested = await send("POST", `/v1/monitors/${id}/test`);
    expect(tested.status).toBe(202);
    expect(typeof tested.body.eventId).toBe("string");

    const archived = await send("DELETE", `/v1/monitors/${id}`);
    expect(archived.body).toMatchObject({ status: "archived" });
  });

  test("pages monitors newest first", async () => {
    const { send } = setup(human("owner"));
    for (const name of ["First", "Second", "Third"]) {
      await send("POST", "/v1/monitors", { ...runFailures, name });
    }
    const first = await send("GET", "/v1/monitors?limit=2");
    expect(first.body.items).toMatchObject([{ name: "Third" }, { name: "Second" }]);
    const second = await send(
      "GET",
      `/v1/monitors?limit=2&cursor=${String(first.body.nextCursor)}`,
    );
    expect(second.body.items).toMatchObject([{ name: "First" }]);
    expect(second.body.nextCursor).toBeUndefined();
  });

  test("rejects an organization kind aimed at an environment and an environment kind without one", async () => {
    const { send } = setup(human("owner"));
    const misplaced = await send("POST", "/v1/monitors", {
      ...runFailures,
      condition: { kind: "budget-threshold", minimumThreshold: 80 },
    });
    expect(misplaced).toMatchObject({ body: { code: "invalid_monitor_target" }, status: 422 });
    const { environmentId: _environment, ...withoutEnvironment } = runFailures;
    const missing = await send("POST", "/v1/monitors", withoutEnvironment);
    expect(missing).toMatchObject({ body: { code: "invalid_monitor_target" }, status: 422 });
  });

  test("members read monitors but only owners and admins change them", async () => {
    const { send } = setup(human("member"));
    expect((await send("GET", "/v1/monitors")).status).toBe(200);
    expect(await send("POST", "/v1/monitors", runFailures)).toMatchObject({
      body: { code: "insufficient_role" },
      status: 403,
    });
  });

  test("environment-narrowed credentials see only their environment's monitors", async () => {
    let identity = human("owner");
    const { send } = setupWith(() => identity);
    await send("POST", "/v1/monitors", runFailures);
    await send("POST", "/v1/monitors", {
      condition: { kind: "budget-threshold", minimumThreshold: 50 },
      name: "Spend",
      notify: { emailPrincipalIds: [], emailRoles: ["billing"], webhooks: false },
    });
    expect(((await send("GET", "/v1/monitors")).body.items as unknown[]).length).toBe(2);

    identity = human("owner", { environmentIds: [OTHER_ENVIRONMENT], projectIds: [PROJECT] });
    expect((await send("GET", "/v1/monitors")).body.items).toEqual([]);
    identity = human("owner", { environmentIds: [ENVIRONMENT], projectIds: [PROJECT] });
    expect((await send("GET", "/v1/monitors")).body.items).toMatchObject([
      { name: "Checkout failing" },
    ]);
  });

  test("each member reads and replaces only their own alert email settings", async () => {
    const { send } = setup(human("viewer"));
    expect((await send("GET", "/v1/alert-notification-preferences")).body).toEqual({
      email: "all",
      mutedMonitorIds: [],
    });
    const saved = await send("PUT", "/v1/alert-notification-preferences", {
      email: "none",
      mutedMonitorIds: [],
    });
    expect(saved).toMatchObject({ body: { email: "none" }, status: 200 });
    expect((await send("GET", "/v1/alert-notification-preferences")).body).toMatchObject({
      email: "none",
    });
  });

  test("API keys cannot hold alert email settings", async () => {
    const { send } = setup(
      human("owner", {
        apiCredentialId: "01J00000000000000000000040",
        authentication: "api-credential",
      }),
    );
    expect(await send("GET", "/v1/alert-notification-preferences")).toMatchObject({
      body: { code: "human_principal_required" },
      status: 403,
    });
  });

  test("lists alert incidents and returns 404 for an unknown incident", async () => {
    const { send } = setup(human("owner"));
    expect((await send("GET", "/v1/alert-incidents")).body).toEqual({ items: [] });
    const created = await send("POST", "/v1/monitors", runFailures);
    expect(
      (
        await send(
          "GET",
          `/v1/monitors/${created.body.id as string}/incidents/01J00000000000000000000099`,
        )
      ).status,
    ).toBe(404);
  });
});
