import { describe, expect, spyOn, test } from "bun:test";
import { BrainAnswerInvalidError } from "@deployments-ai/brains";
import {
  DatabaseError,
  makeIdempotencyPersistence,
  tableForItemType,
  type PlatformRecord,
} from "@deployments-ai/db";
import type { ApiIdentity } from "../api-service-contracts.ts";
import { createBrainApi } from "./api.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const BRAIN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
const QUERY_ATTEMPT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB0";
const timestamp = "2026-07-30T12:00:00.000Z";

const identity = {
  authentication: "tenant-jwt",
  organizationIds: [ORGANIZATION_ID],
  principalId: PRINCIPAL_ID,
  scopes: ["brains:*"],
} as const satisfies ApiIdentity;

const brain = {
  createdAt: timestamp,
  id: BRAIN_ID,
  kind: "company",
  name: "Engineering",
  organizationId: ORGANIZATION_ID,
  ownershipGeneration: 0,
  schemaVersion: 1,
  sensitivity: "internal",
  slug: "engineering",
  status: "active",
  updatedAt: timestamp,
  version: 0,
} as const;

function api(
  overrides: {
    readonly authenticate?: () => Promise<ApiIdentity | null>;
    readonly invoke?: Parameters<typeof createBrainApi>[0]["service"]["invoke"];
    readonly idempotency?: Parameters<typeof createBrainApi>[0]["idempotency"];
  } = {},
) {
  return createBrainApi({
    authenticate: overrides.authenticate ?? (async () => identity),
    idempotency: overrides.idempotency ?? {
      execute: async (input) => input.operation(),
    },
    requestId: () => "request_test",
    service: {
      invoke: overrides.invoke ?? (async () => brain),
    },
  });
}

describe("Brain API dispatcher", () => {
  test("requires an organization disclosure boundary", async () => {
    const response = await api()(
      new Request(`https://api.example/v1/brains/${BRAIN_ID}`, {
        headers: { authorization: "Bearer token" },
      }),
    );
    expect(response?.status).toBe(400);
    expect(await response?.json()).toMatchObject({
      code: "missing_organization_context",
    });
  });

  test("enforces route scopes before invoking the service", async () => {
    let invoked = false;
    const response = await api({
      authenticate: async () => ({ ...identity, scopes: ["brains:read"] }),
      invoke: async () => {
        invoked = true;
        return brain;
      },
    })(
      new Request("https://api.example/v1/brains", {
        body: JSON.stringify({
          kind: "company",
          name: "Engineering",
          slug: "engineering",
        }),
        headers: {
          "content-type": "application/json",
          "idempotency-key": "create-engineering",
          "x-deployments-organization": ORGANIZATION_ID,
        },
        method: "POST",
      }),
    );
    expect(response?.status).toBe(403);
    expect(invoked).toBe(false);
  });

  test("admits platform administrators through the HTTP Brain scope gate", async () => {
    const response = await api({
      authenticate: async () => ({ ...identity, scopes: ["platform:admin"] }),
    })(
      new Request(`https://api.example/v1/brains/${BRAIN_ID}`, {
        headers: { "x-deployments-organization": ORGANIZATION_ID },
      }),
    );

    expect(response?.status).toBe(200);
  });

  test("executes mutations through organization-scoped idempotency", async () => {
    const executions: {
      key: string;
      organizationId?: string;
      principalId: string;
    }[] = [];
    const response = await api({
      idempotency: {
        execute: async (input) => {
          executions.push({
            key: input.key,
            ...(input.organizationId ? { organizationId: input.organizationId } : {}),
            principalId: input.principalId,
          });
          return input.operation();
        },
      },
      invoke: async (routeName, invocation) => {
        expect(routeName).toBe("createBrain");
        expect(invocation.organizationId).toBe(ORGANIZATION_ID);
        return brain;
      },
    })(
      new Request("https://api.example/v1/brains", {
        body: JSON.stringify({
          kind: "company",
          name: "Engineering",
          slug: "engineering",
        }),
        headers: {
          "content-type": "application/json",
          "idempotency-key": "create-engineering",
          "x-deployments-organization": ORGANIZATION_ID,
        },
        method: "POST",
      }),
    );
    expect(response?.status).toBe(201);
    expect(await response?.json()).toEqual(brain);
    expect(executions).toEqual([
      {
        key: `${ORGANIZATION_ID}:create-engineering`,
        organizationId: ORGANIZATION_ID,
        principalId: PRINCIPAL_ID,
      },
    ]);
  });

  test("dispatches source reads through the native Brain service", async () => {
    const response = await api()(
      new Request(`https://api.example/v1/brains/${BRAIN_ID}/sources`, {
        headers: { "x-deployments-organization": ORGANIZATION_ID },
      }),
    );
    expect(response).toBeDefined();
  });

  test("dispatches native search, health, and curator review routes", async () => {
    const invoked: string[] = [];
    const idempotencyKeys: string[] = [];
    const handler = api({
      idempotency: {
        execute: async (input) => {
          idempotencyKeys.push(input.key);
          return input.operation();
        },
      },
      invoke: async (routeName, invocation) => {
        invoked.push(routeName);
        if (routeName === "searchBrains") {
          expect(invocation.identity.projectIds).toEqual([PROJECT_ID]);
          expect(invocation.identity.environmentIds).toEqual([ENVIRONMENT_ID]);
          return { queryAttemptId: QUERY_ATTEMPT_ID, results: [] };
        }
        if (routeName === "listBrainIndexHealth" || routeName === "listBrainReviewItems") {
          return { items: [] };
        }
        throw new Error(`Unexpected route ${routeName}.`);
      },
    });
    const headers = {
      "content-type": "application/json",
      "idempotency-key": "brain-search",
      "x-deployments-environment": ENVIRONMENT_ID,
      "x-deployments-organization": ORGANIZATION_ID,
      "x-deployments-project": PROJECT_ID,
    };
    const search = await handler(
      new Request("https://api.example/v1/brains/search", {
        body: JSON.stringify({ brainIds: [BRAIN_ID], query: "decision" }),
        headers,
        method: "POST",
      }),
    );
    const health = await handler(
      new Request(`https://api.example/v1/brains/${BRAIN_ID}/index-health`, {
        headers: { "x-deployments-organization": ORGANIZATION_ID },
      }),
    );
    const reviews = await handler(
      new Request(`https://api.example/v1/brains/${BRAIN_ID}/review-items`, {
        headers: { "x-deployments-organization": ORGANIZATION_ID },
      }),
    );
    expect([search?.status, health?.status, reviews?.status]).toEqual([200, 200, 200]);
    expect(invoked).toEqual(["searchBrains", "listBrainIndexHealth", "listBrainReviewItems"]);
    expect(idempotencyKeys).toEqual([
      `${ORGANIZATION_ID}:${PROJECT_ID}:${ENVIRONMENT_ID}:brain-search`,
    ]);
  });

  test("requires and authorizes explicit billable query headers", async () => {
    let invoked = false;
    const handler = api({
      authenticate: async () => ({
        ...identity,
        environmentIds: [ENVIRONMENT_ID],
        projectIds: [PROJECT_ID],
      }),
      invoke: async () => {
        invoked = true;
        return { queryAttemptId: QUERY_ATTEMPT_ID, results: [] };
      },
    });
    const request = (headers: Record<string, string>) =>
      handler(
        new Request("https://api.example/v1/brains/search", {
          body: JSON.stringify({ brainIds: [BRAIN_ID], query: "decision" }),
          headers: {
            "content-type": "application/json",
            "idempotency-key": "brain-search-scope",
            "x-deployments-organization": ORGANIZATION_ID,
            ...headers,
          },
          method: "POST",
        }),
      );

    const missing = await request({});
    expect(missing?.status).toBe(400);
    expect(await missing?.json()).toMatchObject({ code: "missing_project_context" });
    const mismatched = await request({
      "x-deployments-environment": ENVIRONMENT_ID,
      "x-deployments-project": BRAIN_ID,
    });
    expect(mismatched?.status).toBe(403);
    expect(await mismatched?.json()).toMatchObject({ code: "project_scope_violation" });
    expect(invoked).toBe(false);
  });

  test("reports an invalid model answer as an upstream failure, not a caller contract error", async () => {
    const response = await api({
      invoke: async () => {
        throw new BrainAnswerInvalidError("malformed-json");
      },
    })(
      new Request("https://api.example/v1/brains/ask", {
        body: JSON.stringify({ brainIds: [BRAIN_ID], question: "Why?" }),
        headers: {
          "content-type": "application/json",
          "idempotency-key": "brain-ask",
          "x-deployments-environment": ENVIRONMENT_ID,
          "x-deployments-organization": ORGANIZATION_ID,
          "x-deployments-project": PROJECT_ID,
        },
        method: "POST",
      }),
    );

    expect(response?.status).toBe(502);
    expect(await response?.json()).toMatchObject({
      code: "brain_answer_invalid",
      detail: "The Brain answer model returned an invalid answer.",
      status: 502,
    });
  });

  test("runs a resent ask once its abandoned first attempt can no longer be running", async () => {
    const records = new Map<string, PlatformRecord>();
    const storageKey = (table: string, pk: string, sk: string) => `${table}\u0000${pk}\u0000${sk}`;
    let clock = Date.parse(timestamp);
    const idempotency = makeIdempotencyPersistence({
      database: {
        deleteRecord: async () => {},
        getRecord: async (table, key) => records.get(storageKey(table, key.pk, key.sk)),
        putRecord: async () => {},
        queryRecords: async () => ({ items: [] }),
        transactWrite: async (operations) => {
          for (const operation of operations) {
            if (operation.kind === "condition-check") continue;
            const { itemType, pk, sk } = operation.record;
            const id = storageKey(tableForItemType(itemType), pk, sk);
            if (operation.kind === "delete") records.delete(id);
            else records.set(id, operation.record);
          }
        },
      },
      now: () => new Date(clock),
      responseProtector: {
        prepare: async () => ({
          dispose: () => undefined,
          protect: async (value) => ({ value }),
        }),
        unprotect: async (value) => value.value,
      },
    });
    const firstAttempt = Promise.withResolvers<void>();
    let attempts = 0;
    const ask = api({
      idempotency,
      invoke: async () => {
        attempts += 1;
        if (attempts > 1) {
          return {
            claims: [],
            gaps: ["No evidence."],
            queryAttemptId: QUERY_ATTEMPT_ID,
            usedCitations: [],
          };
        }
        firstAttempt.resolve();
        return Promise.withResolvers<never>().promise;
      },
    });
    const send = () =>
      ask(
        new Request("https://api.example/v1/brains/ask", {
          body: JSON.stringify({ brainIds: [BRAIN_ID], question: "Why?" }),
          headers: {
            "content-type": "application/json",
            "idempotency-key": "brain-ask-abandoned",
            "x-deployments-environment": ENVIRONMENT_ID,
            "x-deployments-organization": ORGANIZATION_ID,
            "x-deployments-project": PROJECT_ID,
          },
          method: "POST",
        }),
      );

    void send();
    await firstAttempt.promise;
    clock += 30_000;
    const whileRunning = await send();
    clock += 31_000;
    const afterTimeout = await send();

    expect(whileRunning?.status).toBe(409);
    expect(await whileRunning?.json()).toMatchObject({ code: "idempotency_in_progress" });
    expect(afterTimeout?.status).toBe(200);
    expect(await afterTimeout?.json()).toEqual({
      claims: [],
      gaps: ["No evidence."],
      queryAttemptId: QUERY_ATTEMPT_ID,
      usedCitations: [],
    });
    expect(attempts).toBe(2);
  });

  test("logs unexpected failures with bounded diagnostics and no request or error content", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await api({
        invoke: async () => {
          throw new DatabaseError({
            cause: Object.assign(new Error("tenant-secret-key ORG#must-not-log"), {
              name: "ValidationException",
            }),
            message: "DynamoDB transact-write failed for ORG#must-not-log.",
            operation: "transact-write",
            table: "multiple",
          });
        },
      })(
        new Request(`https://api.example/v1/brains/${BRAIN_ID}/erasures`, {
          body: JSON.stringify({ expectedVersion: 0 }),
          headers: {
            "content-type": "application/json",
            "idempotency-key": "brain-erasure",
            "x-deployments-organization": ORGANIZATION_ID,
          },
          method: "POST",
        }),
      );

      expect(response?.status).toBe(500);
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith("Brain API request failed.", {
        causeType: "ValidationException",
        databaseOperation: "transact-write",
        databaseReason: "unknown",
        errorType: "DatabaseError",
        requestId: "request_test",
        route: "eraseBrain",
        status: 500,
      });
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain("must-not-log");
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain("tenant-secret-key");
    } finally {
      consoleError.mockRestore();
    }
  });

  test("does not log caller-attributable failures", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await api({
        invoke: async () => {
          throw { code: "brain_version_conflict", message: "changed", status: 409 };
        },
      })(
        new Request(`https://api.example/v1/brains/${BRAIN_ID}/erasures`, {
          body: JSON.stringify({ expectedVersion: 0 }),
          headers: {
            "content-type": "application/json",
            "idempotency-key": "brain-erasure",
            "x-deployments-organization": ORGANIZATION_ID,
          },
          method: "POST",
        }),
      );

      expect(response?.status).toBe(409);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});
