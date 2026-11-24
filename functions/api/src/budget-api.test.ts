import { operatorAccessGrant } from "@deployments-ai/db/operator-access-testing";
import {
  PersistenceError,
  type BudgetPersistence,
  type BudgetRecordValue,
  type IdempotencyExecution,
  type OrganizationRole,
} from "@deployments-ai/db";
import { describe, expect, spyOn, test } from "bun:test";
import { createBudgetApiHandler, type BudgetTargetEnvironment } from "./budget-api.ts";
import type { ApiIdentity } from "./index.ts";

const ORG = "01J00000000000000000000001";
const OTHER_ORG = "01J00000000000000000000002";
const PROJECT = "01J00000000000000000000010";
const OTHER_PROJECT = "01J00000000000000000000011";
const ENVIRONMENT = "01J00000000000000000000020";
const OTHER_ENVIRONMENT = "01J00000000000000000000021";
const WORKSPACE = "01J00000000000000000000050";
const OTHER_ENVIRONMENT_WORKSPACE = "01J00000000000000000000051";
const ARCHIVED_WORKSPACE = "01J00000000000000000000052";
const PRINCIPAL = "01J00000000000000000000030";
const NOW = "2026-10-01T00:00:00.000Z";

function budgetRecord(
  id: string,
  data: Partial<BudgetRecordValue["data"]> & Pick<BudgetRecordValue["data"], "scope">,
): BudgetRecordValue {
  return {
    data: {
      amountUsdMicros: 100_000_000,
      createdAt: NOW,
      id,
      name: `Budget ${id.slice(-2)}`,
      organizationId: ORG,
      period: "monthly",
      status: "active",
      thresholds: [50, 80, 100],
      updatedAt: NOW,
      version: 1,
      ...data,
    },
    itemType: "budget",
  } as unknown as BudgetRecordValue;
}

const ORG_BUDGET = budgetRecord("01J00000000000000000000101", {
  scope: "organization",
});
const PROJECT_BUDGET = budgetRecord("01J00000000000000000000102", {
  projectId: PROJECT,
  scope: "project",
} as never);
const OTHER_PROJECT_BUDGET = budgetRecord("01J00000000000000000000103", {
  projectId: OTHER_PROJECT,
  scope: "project",
} as never);

function fakeBudgets() {
  const calls: { method: string; input: unknown }[] = [];
  const records = new Map(
    [ORG_BUDGET, PROJECT_BUDGET, OTHER_PROJECT_BUDGET].map((record) => [record.data.id, record]),
  );
  const find = (id: string) => {
    const record = records.get(id as never);
    if (!record) throw new PersistenceError("not-found", "budget_not_found", "Not found.");
    return record;
  };
  const budgets: BudgetPersistence = {
    archive: async (input) => {
      calls.push({ input, method: "archive" });
      const record = find(input.budgetId);
      return {
        ...record,
        data: {
          ...record.data,
          archivedAt: NOW,
          status: "archived",
          version: 2,
        },
      } as BudgetRecordValue;
    },
    create: async (input) => {
      calls.push({ input, method: "create" });
      return budgetRecord("01J00000000000000000000199", {
        ...input.target,
        amountUsdMicros: input.amountUsdMicros,
        name: input.name,
        period: input.period,
      } as never);
    },
    get: async (_organizationId, budgetId) => find(budgetId),
    list: async (input) => {
      calls.push({ input, method: "list" });
      return { items: [...records.values()], nextCursor: "next-page" };
    },
    listPeriods: async (input) => {
      calls.push({ input, method: "listPeriods" });
      return {
        items: [
          {
            amountUsdMicros: 100_000_000,
            budgetId: input.budgetId,
            current: true,
            exhausted: false,
            notifiedThresholds: [50],
            period: "monthly",
            periodEnd: "2026-11-01T00:00:00.000Z",
            periodStart: NOW,
            spendUsdMicros: 60_000_000,
          },
        ],
      };
    },
    update: async (input) => {
      calls.push({ input, method: "update" });
      const record = find(input.budgetId);
      return {
        ...record,
        data: {
          ...record.data,
          ...(input.name ? { name: input.name } : {}),
          version: 2,
        },
      } as BudgetRecordValue;
    },
  };
  return { budgets, calls };
}

function human(role: OrganizationRole, scopes = ["budgets:read", "budgets:write"]): ApiIdentity {
  return {
    organizationIds: [ORG],
    organizationRole: role,
    principalId: PRINCIPAL,
    scopes,
  };
}

function setup(identity: ApiIdentity | null, environment?: Partial<BudgetTargetEnvironment>) {
  const fake = fakeBudgets();
  const idempotent: IdempotencyExecution[] = [];
  const handler = createBudgetApiHandler({
    authenticate: async () => identity,
    budgets: fake.budgets,
    idempotency: {
      execute: async (input) => {
        idempotent.push(input);
        return input.operation();
      },
    },
    requestId: () => "req-test",
    resolveEnvironment: async (_identity, _organizationId, environmentId) => ({
      id: environmentId,
      organizationId: ORG,
      projectId: PROJECT,
      status: "active",
      ...environment,
    }),
    resolveProject: async (_identity, _organizationId, projectId) => {
      if (projectId !== PROJECT) {
        throw new PersistenceError("not-found", "project_not_found", "Not found.");
      }
      return { id: projectId, organizationId: ORG, status: "active" };
    },
    resolveWorkspace: async (_identity, environmentId, workspaceId) => {
      const environmentOf: Record<string, string> = {
        [ARCHIVED_WORKSPACE]: ENVIRONMENT,
        [OTHER_ENVIRONMENT_WORKSPACE]: OTHER_ENVIRONMENT,
        [WORKSPACE]: ENVIRONMENT,
      };
      if (environmentOf[workspaceId] !== environmentId) {
        throw new PersistenceError("not-found", "resource_not_found", "Workspace was not found.");
      }
      return {
        id: workspaceId,
        organizationId: ORG,
        status: workspaceId === ARCHIVED_WORKSPACE ? "archived" : "active",
      };
    },
  });
  return { ...fake, handler, idempotent };
}

async function send(
  handler: (request: Request) => Promise<Response | undefined>,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const response = await handler(
    new Request(`https://api.example${path}`, {
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: {
        "x-deployments-organization": ORG,
        ...(method === "GET" ? {} : { "idempotency-key": "key-1" }),
        ...headers,
      },
      method,
    }),
  );
  if (!response) throw new Error(`No route handled ${method} ${path}`);
  return {
    body: (await response.json()) as Record<string, any>,
    status: response.status,
  };
}

const createBody = {
  amountUsdMicros: 250_000_000,
  name: "Monthly cap",
  period: "monthly",
  scope: "project",
  projectId: PROJECT,
};

describe("budget API", () => {
  test("ignores routes outside the budget family", async () => {
    const { handler } = setup(human("owner"));
    expect(await handler(new Request("https://api.example/v1/projects"))).toBeUndefined();
  });

  test("requires authentication and the organization header", async () => {
    expect((await send(setup(null).handler, "GET", "/v1/budgets")).status).toBe(401);
    const missing = await send(setup(human("viewer")).handler, "GET", "/v1/budgets", undefined, {
      "x-deployments-organization": "",
    });
    expect(missing.status).toBe(400);
    const outside = await send(setup(human("owner")).handler, "GET", "/v1/budgets", undefined, {
      "x-deployments-organization": OTHER_ORG,
    });
    expect(outside).toMatchObject({
      body: { code: "organization_scope_violation" },
      status: 403,
    });
  });

  test.each(["owner", "admin", "billing"] as const)(
    "%s can create, update, and archive",
    async (role) => {
      const { calls, handler, idempotent } = setup(human(role));
      const created = await send(handler, "POST", "/v1/budgets", createBody);
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        projectId: PROJECT,
        scope: "project",
      });
      expect(calls[0]).toMatchObject({
        input: {
          actor: { id: PRINCIPAL, type: "principal" },
          organizationId: ORG,
          target: { projectId: PROJECT, scope: "project" },
        },
        method: "create",
      });
      const updated = await send(handler, "PATCH", `/v1/budgets/${PROJECT_BUDGET.data.id}`, {
        name: "Renamed",
      });
      expect(updated).toMatchObject({
        body: { name: "Renamed", version: 2 },
        status: 200,
      });
      const archived = await send(handler, "DELETE", `/v1/budgets/${ORG_BUDGET.data.id}`);
      expect(archived).toMatchObject({
        body: { status: "archived" },
        status: 200,
      });
      expect(idempotent.map((input) => input.organizationId)).toEqual([ORG, ORG, ORG]);
    },
  );

  test.each(["member", "viewer"] as const)(
    "%s reads budgets but cannot change them",
    async (role) => {
      const { calls, handler } = setup(human(role));
      expect((await send(handler, "GET", "/v1/budgets")).status).toBe(200);
      expect((await send(handler, "GET", `/v1/budgets/${ORG_BUDGET.data.id}`)).status).toBe(200);
      const periods = await send(handler, "GET", `/v1/budgets/${ORG_BUDGET.data.id}/periods`);
      expect(periods).toMatchObject({
        body: {
          items: [{ notifiedThresholds: [50], spendUsdMicros: 60_000_000 }],
        },
        status: 200,
      });
      for (const [method, path, body] of [
        ["POST", "/v1/budgets", createBody],
        ["PATCH", `/v1/budgets/${ORG_BUDGET.data.id}`, { status: "paused" }],
        ["DELETE", `/v1/budgets/${ORG_BUDGET.data.id}`, undefined],
      ] as const) {
        const denied = await send(handler, method, path, body);
        expect(denied.status).toBe(403);
        expect(denied.body.code).toBe("insufficient_role");
        expect(denied.body.detail).toContain("owner, admin, billing");
      }
      expect(
        calls.filter((call) => call.method !== "list" && call.method !== "listPeriods"),
      ).toEqual([]);
    },
  );

  test("requires budget scopes", async () => {
    const { handler } = setup(human("owner", ["budgets:read"]));
    const denied = await send(handler, "POST", "/v1/budgets", createBody);
    expect(denied).toMatchObject({
      body: { code: "insufficient_scope" },
      status: 403,
    });
    expect(
      (await send(setup(human("viewer", ["projects:read"])).handler, "GET", "/v1/budgets")).status,
    ).toBe(403);
    expect(
      (await send(setup(human("owner", ["budgets:*"])).handler, "POST", "/v1/budgets", createBody))
        .status,
    ).toBe(201);
  });

  test("platform administrators under operator access bypass membership and roles", async () => {
    const administrator = (organizationId: string): ApiIdentity => ({
      authentication: "tenant-jwt",
      operatorAccess: operatorAccessGrant(organizationId),
      organizationIds: [ORG],
      principalId: PRINCIPAL,
      platformRole: "administrator",
      scopes: ["budgets:write"],
    });
    const { handler } = setup(administrator(ORG));
    expect((await send(handler, "POST", "/v1/budgets", createBody)).status).toBe(201);
    const elsewhere = setup(administrator(OTHER_ORG)).handler;
    expect((await send(elsewhere, "POST", "/v1/budgets", createBody)).status).toBe(403);
  });

  test("API keys are governed by scopes alone", async () => {
    const apiKey = (scopes: string[]): ApiIdentity => ({
      apiCredentialId: "01J00000000000000000000040",
      authentication: "api-credential",
      organizationIds: [ORG],
      principalId: "01J00000000000000000000041",
      scopes,
    });
    const { calls, handler } = setup(apiKey(["budgets:write"]));
    expect((await send(handler, "POST", "/v1/budgets", createBody)).status).toBe(201);
    expect(calls[0]).toMatchObject({
      input: { actor: { type: "service-account" } },
    });
    const readOnly = await send(
      setup(apiKey(["budgets:read"])).handler,
      "POST",
      "/v1/budgets",
      createBody,
    );
    expect(readOnly).toMatchObject({
      body: { code: "insufficient_scope" },
      status: 403,
    });
  });

  test("narrowed identities only see budgets on resources they hold", async () => {
    const identity: ApiIdentity = {
      ...human("admin"),
      environmentIds: "*",
      projectIds: [PROJECT],
    };
    const { handler } = setup(identity);
    const listed = await send(handler, "GET", "/v1/budgets");
    expect(listed.body.items.map((item: { id: string }) => item.id)).toEqual([
      PROJECT_BUDGET.data.id,
    ]);
    expect(listed.body.nextCursor).toBe("next-page");
    for (const budget of [ORG_BUDGET, OTHER_PROJECT_BUDGET]) {
      const hidden = await send(handler, "GET", `/v1/budgets/${budget.data.id}`);
      expect(hidden).toMatchObject({
        body: { code: "budget_not_found" },
        status: 404,
      });
      expect((await send(handler, "DELETE", `/v1/budgets/${budget.data.id}`)).status).toBe(404);
      expect((await send(handler, "GET", `/v1/budgets/${budget.data.id}/periods`)).status).toBe(
        404,
      );
    }
    const orgCreate = await send(handler, "POST", "/v1/budgets", {
      ...createBody,
      projectId: undefined,
      scope: "organization",
    });
    expect(orgCreate).toMatchObject({
      body: { code: "budget_scope_violation" },
      status: 403,
    });
  });

  test("validates create targets", async () => {
    const { calls, handler } = setup(human("owner"));
    const invalid = [
      { ...createBody, scope: "organization" },
      { ...createBody, projectId: undefined },
      { ...createBody, environmentId: ENVIRONMENT },
      { ...createBody, projectId: undefined, scope: "environment" },
      {
        ...createBody,
        environmentId: ENVIRONMENT,
        projectId: OTHER_PROJECT,
        scope: "environment",
      },
    ];
    for (const body of invalid) {
      const response = await send(handler, "POST", "/v1/budgets", body);
      expect(response).toMatchObject({
        body: { code: "invalid_budget_target" },
        status: 422,
      });
    }
    const unknownProject = await send(handler, "POST", "/v1/budgets", {
      ...createBody,
      projectId: OTHER_PROJECT,
    });
    expect(unknownProject.status).toBe(404);
    const environment = await send(handler, "POST", "/v1/budgets", {
      ...createBody,
      environmentId: ENVIRONMENT,
      projectId: undefined,
      scope: "environment",
    });
    expect(environment).toMatchObject({
      body: {
        environmentId: ENVIRONMENT,
        projectId: PROJECT,
        scope: "environment",
      },
      status: 201,
    });
    expect(calls).toHaveLength(1);

    const archived = setup(human("owner"), { status: "archived" });
    const inactive = await send(archived.handler, "POST", "/v1/budgets", {
      ...createBody,
      environmentId: ENVIRONMENT,
      projectId: undefined,
      scope: "environment",
    });
    expect(inactive).toMatchObject({
      body: { code: "environment_not_active" },
      status: 409,
    });
    const foreign = setup(human("owner"), { organizationId: OTHER_ORG });
    const foreignEnvironment = await send(foreign.handler, "POST", "/v1/budgets", {
      ...createBody,
      environmentId: ENVIRONMENT,
      projectId: undefined,
      scope: "environment",
    });
    expect(foreignEnvironment.status).toBe(404);
  });

  test("creates a workspace budget with an API key bound to the workspace's environment", async () => {
    const apiKey: ApiIdentity = {
      apiCredentialId: "01J00000000000000000000040",
      authentication: "api-credential",
      environmentIds: [ENVIRONMENT],
      organizationIds: [ORG],
      principalId: "01J00000000000000000000041",
      projectIds: [PROJECT],
      scopes: ["budgets:read", "budgets:write"],
      workspaceId: WORKSPACE,
    };
    const { calls, handler } = setup(apiKey);
    const workspaceBody = {
      ...createBody,
      environmentId: ENVIRONMENT,
      projectId: undefined,
      scope: "workspace",
      workspaceId: WORKSPACE,
    };

    const created = await send(handler, "POST", "/v1/budgets", workspaceBody);
    expect(created).toEqual({
      body: {
        amountUsdMicros: 250_000_000,
        createdAt: NOW,
        environmentId: ENVIRONMENT,
        id: "01J00000000000000000000199",
        name: "Monthly cap",
        organizationId: ORG,
        period: "monthly",
        projectId: PROJECT,
        scope: "workspace",
        status: "active",
        thresholds: [50, 80, 100],
        updatedAt: NOW,
        version: 1,
        workspaceId: WORKSPACE,
      },
      status: 201,
    });
    expect(calls[0]).toMatchObject({
      input: {
        target: {
          environmentId: ENVIRONMENT,
          projectId: PROJECT,
          scope: "workspace",
          workspaceId: WORKSPACE,
        },
      },
      method: "create",
    });

    const archived = await send(handler, "POST", "/v1/budgets", {
      ...workspaceBody,
      workspaceId: ARCHIVED_WORKSPACE,
    });
    expect(archived).toMatchObject({ body: { code: "workspace_not_active" }, status: 409 });
    const elsewhere = await send(handler, "POST", "/v1/budgets", {
      ...workspaceBody,
      workspaceId: OTHER_ENVIRONMENT_WORKSPACE,
    });
    expect(elsewhere).toMatchObject({ body: { code: "resource_not_found" }, status: 404 });
    for (const body of [
      { ...workspaceBody, workspaceId: undefined },
      { ...workspaceBody, environmentId: undefined },
      { ...workspaceBody, scope: "environment" },
      { ...workspaceBody, environmentId: undefined, projectId: PROJECT, scope: "project" },
    ]) {
      expect(await send(handler, "POST", "/v1/budgets", body)).toMatchObject({
        body: { code: "invalid_budget_target" },
        status: 422,
      });
    }
    expect(calls).toHaveLength(1);
  });

  test("shows a workspace budget only to identities that hold its environment", async () => {
    const workspaceBudget = budgetRecord("01J00000000000000000000104", {
      environmentId: ENVIRONMENT,
      projectId: PROJECT,
      scope: "workspace",
      workspaceId: WORKSPACE,
    } as never);
    const visibleTo = async (environmentIds: readonly string[]) => {
      const fake = setup({ ...human("admin"), environmentIds, projectIds: [PROJECT] });
      (fake.budgets as { get: BudgetPersistence["get"] }).get = async () => workspaceBudget;
      return (await send(fake.handler, "GET", `/v1/budgets/${workspaceBudget.data.id}`)).status;
    };
    expect(await visibleTo([ENVIRONMENT])).toBe(200);
    expect(await visibleTo([OTHER_ENVIRONMENT])).toBe(404);
  });

  test("rejects malformed requests against the contract", async () => {
    const { handler } = setup(human("owner"));
    for (const body of [
      { ...createBody, thresholds: [80, 50] },
      { ...createBody, amountUsdMicros: 0 },
      { ...createBody, extra: true },
    ]) {
      expect((await send(handler, "POST", "/v1/budgets", body)).status).toBe(422);
    }
    expect((await send(handler, "PATCH", `/v1/budgets/${ORG_BUDGET.data.id}`, {})).status).toBe(
      422,
    );
    expect(
      (
        await send(handler, "POST", "/v1/budgets", createBody, {
          "idempotency-key": "",
        })
      ).status,
    ).toBe(400);
    expect((await send(handler, "GET", "/v1/budgets?limit=101")).status).toBe(400);
    expect(
      (await send(handler, "GET", `/v1/budgets/${ORG_BUDGET.data.id}/periods?limit=25`)).status,
    ).toBe(400);
    expect((await send(handler, "GET", "/v1/budgets/not-an-id")).status).toBe(404);
  });

  test("maps persistence conflicts to problem responses", async () => {
    const fake = setup(human("owner"));
    (fake.budgets as { update: BudgetPersistence["update"] }).update = async () => {
      throw new PersistenceError("conflict", "budget_archived", "Archived.");
    };
    const response = await send(fake.handler, "PATCH", `/v1/budgets/${ORG_BUDGET.data.id}`, {
      status: "active",
    });
    expect(response).toMatchObject({
      body: { code: "budget_archived" },
      status: 409,
    });
  });

  test("logs one bounded cause for an unexpected persistence failure", async () => {
    const fake = setup(human("owner"));
    spyOn(fake.budgets, "update").mockImplementation(async () => {
      throw Object.assign(new Error("DynamoDB is unavailable."), { name: "ServiceUnavailable" });
    });
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await send(fake.handler, "PATCH", `/v1/budgets/${ORG_BUDGET.data.id}`, {
        status: "active",
      });
      expect(response).toEqual({
        body: {
          code: "internal_error",
          detail: "The budget request failed.",
          requestId: "req-test",
          status: 500,
          title: "Request failed",
        },
        status: 500,
      });
      expect(consoleError.mock.calls).toEqual([
        [
          "Budget API request failed.",
          {
            error: "DynamoDB is unavailable.",
            errorType: "ServiceUnavailable",
            requestId: "req-test",
            route: "updateBudget",
          },
        ],
      ]);
    } finally {
      consoleError.mockRestore();
    }
  });
});
