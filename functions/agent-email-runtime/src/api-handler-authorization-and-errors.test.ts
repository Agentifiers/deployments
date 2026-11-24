import { AgentEmailPersistenceError, DatabaseError, PersistenceError } from "@deployments-ai/db";
import { describe, expect, spyOn, test } from "bun:test";
import {
  AGENT_EMAIL_API_ROUTES,
  AgentEmailApiError,
  createAgentEmailApiHandler,
  type AgentEmailApiDependencies,
  type AgentEmailApiIdentity,
  type AgentEmailApiInvocation,
  type AgentEmailApiOperation,
  type AgentEmailHttpEvent,
} from "./api-handler.ts";

const scope = {
  environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
} as const;

const identity: AgentEmailApiIdentity = {
  permissions: ["agent-email:*"],
  principalId: "principal_1",
  scope,
};

function event(
  method: string,
  rawPath: string,
  options: {
    readonly body?: unknown;
    readonly headers?: Readonly<Record<string, string>>;
    readonly query?: Readonly<Record<string, string>>;
  } = {},
): AgentEmailHttpEvent {
  return {
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    headers: {
      authorization: "Bearer credential",
      "x-deployments-environment": scope.environmentId,
      "x-deployments-organization": scope.organizationId,
      "x-deployments-project": scope.projectId,
      ...options.headers,
    },
    ...(options.query ? { queryStringParameters: options.query } : {}),
    rawPath,
    requestContext: { http: { method }, requestId: "request_1" },
  };
}

function routePath(path: string) {
  return path.replaceAll(/:[^/]+/gu, "resource_1");
}

function dependencies(
  options: {
    readonly authenticated?: AgentEmailApiIdentity | null;
    readonly execute?: (
      operation: AgentEmailApiOperation,
      invocation: AgentEmailApiInvocation,
    ) => Promise<unknown>;
    readonly idempotencyError?: PersistenceError;
  } = {},
) {
  const calls: Array<{
    readonly invocation: AgentEmailApiInvocation;
    readonly operation: AgentEmailApiOperation;
  }> = [];
  const idempotency: Parameters<AgentEmailApiDependencies["idempotency"]["execute"]>[0][] = [];
  const usage: Parameters<NonNullable<AgentEmailApiDependencies["recordApiCredentialUsage"]>>[0][] =
    [];
  const runtime: AgentEmailApiDependencies = {
    authenticate: async () =>
      options.authenticated === undefined ? identity : options.authenticated,
    idempotency: {
      execute: async (input) => {
        idempotency.push(input);
        if (options.idempotencyError) throw options.idempotencyError;
        return input.operation();
      },
    },
    recordApiCredentialUsage: async (input) => {
      usage.push(input);
    },
    service: {
      execute: async (operation, invocation) => {
        calls.push({ invocation, operation });
        return options.execute?.(operation, invocation) ?? { operation };
      },
    },
  };
  return { calls, idempotency, runtime, usage };
}

function parsed(result: { readonly body: string }) {
  return JSON.parse(result.body) as Record<string, unknown>;
}

describe("agent email API handler", () => {
  test("matches the public read, write, and admin permission boundaries", () => {
    expect(
      AGENT_EMAIL_API_ROUTES.filter((route) => route.permission === "agent-email:admin").map(
        (route) => route.operation,
      ),
    ).toEqual([
      "reprocessRawMessage",
      "createDomain",
      "refreshDomain",
      "revokeDomain",
      "createPlacement",
      "updatePlacement",
      "approveDraft",
      "rejectDraft",
      "updatePolicy",
      "createSuppression",
      "removeSuppression",
    ]);
    expect(
      AGENT_EMAIL_API_ROUTES.filter((route) => route.method === "POST" && !route.idempotent).map(
        (route) => route.operation,
      ),
    ).toEqual([
      "searchInboxMessages",
      "createRawMessageAccess",
      "createAttachmentAccessUrl",
      "searchInboxThreads",
      "exportUsage",
    ]);
  });

  test("requires and forwards idempotency for every durable mutation", async () => {
    const runtime = dependencies();
    const handler = createAgentEmailApiHandler(runtime.runtime);
    for (const route of AGENT_EMAIL_API_ROUTES.filter((candidate) => candidate.idempotent)) {
      const missing = await handler(
        event(route.method, routePath(route.path), {
          body: route.body === "required" ? {} : undefined,
        }),
      );
      expect(parsed(missing)).toMatchObject({
        code: "missing_idempotency_key",
        status: 400,
      });
    }

    const result = await handler(
      event("PATCH", "/v1/agent-email/inboxes/inbox_1", {
        body: { name: "Support" },
        headers: { "idempotency-key": "update-inbox-1" },
      }),
    );
    expect(result.statusCode).toBe(200);
    expect(runtime.calls.at(-1)?.invocation.idempotencyKey).toBe("update-inbox-1");
    expect(runtime.idempotency.at(-1)).toMatchObject({
      key: "update-inbox-1",
      organizationId: scope.organizationId,
      principalId: identity.principalId,
    });
    expect(runtime.idempotency.at(-1)?.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });

  test("dispatches binding CRUD and keeps read-only POSTs non-idempotent", async () => {
    const runtime = dependencies();
    const handler = createAgentEmailApiHandler(runtime.runtime);
    const created = await handler(
      event("POST", "/v1/agent-email/inboxes/inbox_1/bindings", {
        body: {
          agentDeploymentId: "deployment_1",
          bindingType: "platform_agent",
        },
        headers: { "idempotency-key": "binding-create-1" },
      }),
    );
    const deleted = await handler(
      event("DELETE", "/v1/agent-email/bindings/binding_1", {
        headers: { "idempotency-key": "binding-delete-1" },
      }),
    );
    const rawAccess = await handler(event("POST", "/v1/agent-email/messages/message_1/raw/access"));
    const attachmentAccess = await handler(
      event("POST", "/v1/agent-email/attachments/attachment_1/access-url"),
    );
    const usageExport = await handler(
      event("POST", "/v1/agent-email/usage/export", {
        body: { format: "csv" },
      }),
    );

    expect([
      created.statusCode,
      deleted.statusCode,
      rawAccess.statusCode,
      attachmentAccess.statusCode,
      usageExport.statusCode,
    ]).toEqual([201, 200, 200, 200, 200]);
    expect(runtime.calls.map((call) => call.operation)).toEqual([
      "createBinding",
      "deleteBinding",
      "createRawMessageAccess",
      "createAttachmentAccessUrl",
      "exportUsage",
    ]);
    expect(runtime.idempotency.map((entry) => entry.key)).toEqual([
      "binding-create-1",
      "binding-delete-1",
    ]);
  });

  test("produces stable idempotency fingerprints for reordered JSON objects", async () => {
    const runtime = dependencies();
    const handler = createAgentEmailApiHandler(runtime.runtime);
    await handler(
      event("PATCH", "/v1/agent-email/policy", {
        body: { maxRecipientsPerMessage: 10, rawRetentionDays: 30 },
        headers: { "idempotency-key": "policy-1" },
      }),
    );
    await handler(
      event("PATCH", "/v1/agent-email/policy", {
        body: { rawRetentionDays: 30, maxRecipientsPerMessage: 10 },
        headers: { "idempotency-key": "policy-1" },
      }),
    );
    expect(runtime.idempotency[0]?.fingerprint).toBe(runtime.idempotency[1]?.fingerprint);
  });

  test.each(["idempotency_conflict", "idempotency_in_progress"] as const)(
    "returns conflict responses for %s persistence failures",
    async (code) => {
      const runtime = dependencies({
        idempotencyError: new PersistenceError("conflict", code, "Idempotency conflict."),
      });
      const handler = createAgentEmailApiHandler(runtime.runtime);
      const result = await handler(
        event("POST", "/v1/agent-email/inboxes", {
          body: {},
          headers: { "idempotency-key": "conflicting-key" },
        }),
      );

      expect(result.statusCode).toBe(409);
      expect(parsed(result)).toMatchObject({ code, status: 409 });
    },
  );

  test("returns conflict responses for repository-wrapped persistence failures", async () => {
    const handler = createAgentEmailApiHandler(
      dependencies({
        execute: async () => {
          throw new AgentEmailPersistenceError({
            cause: new PersistenceError("conflict", "write_conflict", "Concurrent update."),
            message: "Agent email update failed.",
            operation: "update-inbox",
          });
        },
      }).runtime,
    );

    const result = await handler(event("GET", "/v1/agent-email/inboxes"));
    expect(result.statusCode).toBe(409);
    expect(parsed(result)).toMatchObject({ code: "write_conflict", status: 409 });
  });

  test("returns conflict responses for repository-wrapped DynamoDB conditions", async () => {
    const handler = createAgentEmailApiHandler(
      dependencies({
        execute: async () => {
          throw new AgentEmailPersistenceError({
            cause: new DatabaseError({
              cause: new Error("ConditionalCheckFailedException"),
              message: "DynamoDB transact-write conflicted for table multiple.",
              operation: "transact-write",
              reason: "conflict",
              table: "multiple",
            }),
            message: "Agent email create-inbox failed.",
            operation: "create-inbox",
          });
        },
      }).runtime,
    );

    const result = await handler(event("GET", "/v1/agent-email/inboxes"));
    expect(result.statusCode).toBe(409);
    expect(parsed(result)).toMatchObject({ code: "write_conflict", status: 409 });
    expect(result.body).not.toContain("ConditionalCheckFailedException");
  });

  test("enforces JSON object body requirements and rejects bodies on bodyless routes", async () => {
    const runtime = dependencies();
    const handler = createAgentEmailApiHandler(runtime.runtime);
    const missing = await handler(
      event("POST", "/v1/agent-email/inboxes", {
        headers: { "idempotency-key": "inbox-1" },
      }),
    );
    expect(parsed(missing)).toMatchObject({
      code: "invalid_request",
      status: 400,
    });

    const malformed = await handler({
      ...event("POST", "/v1/agent-email/inboxes", {
        headers: { "idempotency-key": "inbox-2" },
      }),
      body: "{",
    });
    expect(parsed(malformed)).toMatchObject({
      code: "invalid_json",
      status: 400,
    });

    const array = await handler(
      event("POST", "/v1/agent-email/inboxes", {
        body: [],
        headers: { "idempotency-key": "inbox-3" },
      }),
    );
    expect(parsed(array)).toMatchObject({
      code: "invalid_request",
      status: 400,
    });

    const unexpected = await handler(
      event("POST", "/v1/agent-email/domains/domain_1/refresh", {
        body: {},
        headers: { "idempotency-key": "domain-refresh-1" },
      }),
    );
    expect(parsed(unexpected)).toMatchObject({
      code: "unexpected_request_body",
      status: 400,
    });
  });

  test("validates pagination and idempotency bounds", async () => {
    const handler = createAgentEmailApiHandler(dependencies().runtime);
    for (const limit of ["0", "101", "1.5", "many"]) {
      const result = await handler(event("GET", "/v1/agent-email/inboxes", { query: { limit } }));
      expect(parsed(result)).toMatchObject({
        code: "invalid_query",
        status: 400,
      });
    }
    const key = await handler(
      event("POST", "/v1/agent-email/domains/domain_1/refresh", {
        headers: { "idempotency-key": "x".repeat(513) },
      }),
    );
    expect(parsed(key)).toMatchObject({
      code: "invalid_idempotency_key",
      status: 400,
    });
  });

  test("supports base64 JSON and optional export bodies", async () => {
    const runtime = dependencies();
    const handler = createAgentEmailApiHandler(runtime.runtime);
    const encoded = Buffer.from(JSON.stringify({ format: "csv" }), "utf8").toString("base64");
    const result = await handler({
      ...event("POST", "/v1/agent-email/usage/export"),
      body: encoded,
      isBase64Encoded: true,
    });
    expect(result.statusCode).toBe(200);
    expect(runtime.calls.at(-1)?.invocation.body).toEqual({ format: "csv" });

    const empty = await handler(event("POST", "/v1/agent-email/usage/export"));
    expect(empty.statusCode).toBe(200);
    expect(runtime.calls.at(-1)?.invocation.body).toBeUndefined();
  });

  test("preserves declared success statuses and emits safe problem responses", async () => {
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    const runtime = dependencies({
      execute: async (operation) => {
        if (operation === "getInbox") {
          throw new AgentEmailApiError(404, "inbox_not_found", "Inbox was not found.");
        }
        if (operation === "getPlacement") {
          throw new AgentEmailApiError(
            503,
            "placement_provider_unavailable",
            "Placement provider is unavailable.",
          );
        }
        if (operation === "getDomain") {
          throw new Error("secret provider failure\nAuthorization: Bearer must-not-log");
        }
        if (operation === "getPolicy") {
          const denied = Object.assign(
            new Error(
              "User: arn:aws:sts::123456789012:assumed-role/deployments-ai-platform-dev-agent-email-api/session-1 is not authorized to perform: kms:Decrypt on resource: arn:aws:kms:us-east-2:123456789012:key/01234567-89ab-cdef-0123-456789abcdef because no identity-based policy allows the kms:Decrypt action\nAuthorization: Bearer database-secret-must-not-log",
            ),
            { $metadata: { httpStatusCode: 400 }, name: "AccessDeniedException" },
          );
          throw new DatabaseError({
            cause: denied,
            message: "DynamoDB get failed for table control.",
            operation: "get",
            reason: "unknown",
            table: "control",
          });
        }
        return { operation };
      },
    });
    try {
      const handler = createAgentEmailApiHandler(runtime.runtime);
      const created = await handler(
        event("POST", "/v1/agent-email/inboxes", {
          body: {},
          headers: { "idempotency-key": "create-inbox-status" },
        }),
      );
      expect(created.statusCode).toBe(201);
      expect(created.headers).toMatchObject({
        "cache-control": "no-store",
        "content-type": "application/json",
        "x-request-id": "request_1",
      });

      const notFound = await handler(event("GET", "/v1/agent-email/inboxes/inbox_1"));
      expect(notFound.statusCode).toBe(404);
      expect(notFound.headers["content-type"]).toBe("application/problem+json");
      expect(parsed(notFound)).toMatchObject({
        code: "inbox_not_found",
        requestId: "request_1",
        status: 404,
        title: "Inbox was not found.",
      });

      const internal = await handler(event("GET", "/v1/agent-email/domains/domain_1"));
      expect(parsed(internal)).toMatchObject({
        code: "internal_error",
        status: 500,
        title: "Internal server error",
      });
      expect(internal.body).not.toContain("secret provider failure");
      expect(consoleError).toHaveBeenCalledWith(
        "Agent Email API request failed.",
        expect.objectContaining({ errorType: "Error", requestId: "request_1" }),
      );
      const unavailable = await handler(event("GET", "/v1/agent-email/placements/placement_1"));
      expect(unavailable.statusCode).toBe(503);
      expect(consoleError).toHaveBeenCalledWith(
        "Agent Email API request failed.",
        expect.objectContaining({ errorType: "AgentEmailApiError", requestId: "request_1" }),
      );
      const denied = await handler(event("GET", "/v1/agent-email/policy"));
      expect(denied.statusCode).toBe(500);
      expect(consoleError).toHaveBeenCalledWith(
        "Agent Email API request failed.",
        expect.objectContaining({
          databaseAccessDeniedReason: "missing_identity_permission",
          databaseAssumedRole: "deployments-ai-platform-dev-agent-email-api",
          databaseDeniedAction: "kms:Decrypt",
          databaseDeniedResource:
            "arn:aws:kms:us-east-2:123456789012:key/01234567-89ab-cdef-0123-456789abcdef",
        }),
      );
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain("secret provider failure");
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain("must-not-log");
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain("database-secret");
    } finally {
      consoleError.mockRestore();
    }
  });
});
