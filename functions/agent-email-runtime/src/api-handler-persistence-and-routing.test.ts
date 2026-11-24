import { AGENT_EMAIL_API_ROUTES as PUBLIC_AGENT_EMAIL_API_ROUTES } from "@deployments-ai/api-contract/agent-email";
import { AgentEmailPersistenceError, DatabaseError, PersistenceError } from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import {
  AGENT_EMAIL_API_ROUTES,
  createAgentEmailApiHandler,
  executeAgentEmailIdempotentOperation,
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
  test("unwraps ambiguous repository writes before the idempotency boundary", async () => {
    const ambiguous = new PersistenceError(
      "internal",
      "ambiguous_write_outcome",
      "The write outcome is unknown.",
    );

    expect(
      executeAgentEmailIdempotentOperation(async () => {
        throw new AgentEmailPersistenceError({
          cause: ambiguous,
          message: "Agent email persistence outcome is unknown.",
          operation: "create-inbox",
        });
      }),
    ).rejects.toBe(ambiguous);
  });

  test("converts unknown repository database writes before the idempotency boundary", async () => {
    expect(
      executeAgentEmailIdempotentOperation(async () => {
        throw new AgentEmailPersistenceError({
          cause: new DatabaseError({
            cause: new Error("The transaction response was lost."),
            message: "DynamoDB transact-write failed for table multiple.",
            operation: "transact-write",
            reason: "unknown",
            table: "multiple",
          }),
          message: "Agent email create-with-event failed.",
          operation: "create-with-event",
        });
      }),
    ).rejects.toMatchObject({
      code: "ambiguous_write_outcome",
      kind: "internal",
    });
  });

  test("does not treat unknown repository reads as ambiguous writes", async () => {
    const readFailure = new AgentEmailPersistenceError({
      cause: new DatabaseError({
        cause: new Error("The read response was lost."),
        message: "DynamoDB get failed for table control.",
        operation: "get",
        reason: "unknown",
        table: "control",
      }),
      message: "Agent email get-inbox failed.",
      operation: "get-inbox",
    });

    expect(
      executeAgentEmailIdempotentOperation(async () => {
        throw readFailure;
      }),
    ).rejects.toBe(readFailure);
  });

  test("preserves an ambiguous write when its reconciliation read also fails", async () => {
    const ambiguous = new PersistenceError(
      "internal",
      "ambiguous_write_outcome",
      "The write outcome is unknown.",
    );

    expect(
      executeAgentEmailIdempotentOperation(async () => {
        throw new AggregateError(
          [
            new AgentEmailPersistenceError({
              cause: ambiguous,
              message: "Agent email persistence outcome is unknown.",
              operation: "persist-message",
            }),
            new Error("The reconciliation read failed."),
          ],
          "Agent email message persistence outcome could not be reconciled.",
        );
      }),
    ).rejects.toBe(ambiguous);
  });

  test("records authenticated API credential usage", async () => {
    const authenticated: AgentEmailApiIdentity = {
      ...identity,
      apiCredentialId: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
      authentication: "api-credential",
    };
    const runtime = dependencies({ authenticated });
    const handler = createAgentEmailApiHandler(runtime.runtime);

    expect(handler(event("GET", "/v1/agent-email/inboxes"))).resolves.toMatchObject({
      statusCode: 200,
    });
    expect(runtime.usage).toEqual([
      {
        apiCredentialId: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
        ...scope,
        outcome: "allowed",
        requestMethod: "GET",
        requestPath: "/v1/agent-email/inboxes",
      },
    ]);
  });

  test("records denied and error outcomes for failed API credential requests", async () => {
    const authenticated: AgentEmailApiIdentity = {
      ...identity,
      apiCredentialId: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
      authentication: "api-credential",
      permissions: ["agent-email:read"],
    };
    const deniedRuntime = dependencies({ authenticated });
    const deniedHandler = createAgentEmailApiHandler(deniedRuntime.runtime);

    expect(
      deniedHandler(
        event("POST", "/v1/agent-email/inboxes", {
          body: {},
          headers: { "idempotency-key": "denied-inbox-create" },
        }),
      ),
    ).resolves.toMatchObject({ statusCode: 403 });
    expect(deniedRuntime.usage).toEqual([expect.objectContaining({ outcome: "denied" })]);

    const errorRuntime = dependencies({
      authenticated,
      execute: async () => {
        throw new Error("provider unavailable");
      },
    });
    const errorHandler = createAgentEmailApiHandler(errorRuntime.runtime);

    expect(errorHandler(event("GET", "/v1/agent-email/inboxes"))).resolves.toMatchObject({
      statusCode: 500,
    });
    expect(errorRuntime.usage).toEqual([expect.objectContaining({ outcome: "error" })]);
  });

  test("declares all 46 public operations exactly once", () => {
    expect(AGENT_EMAIL_API_ROUTES).toHaveLength(46);
    expect(new Set(AGENT_EMAIL_API_ROUTES.map((route) => route.operation)).size).toBe(46);
    expect(
      new Set(AGENT_EMAIL_API_ROUTES.map((route) => `${route.method} ${route.path}`)).size,
    ).toBe(46);
  });

  test("stays in exact public authorization, idempotency, and route parity", () => {
    expect(
      AGENT_EMAIL_API_ROUTES.map((route) => ({
        authorization: route.permission,
        idempotency: route.idempotent ? "required" : "none",
        method: route.method,
        path: route.path,
        successStatus: route.successStatus,
      })),
    ).toEqual(
      PUBLIC_AGENT_EMAIL_API_ROUTES.map((route) => ({
        authorization: route.requiredAuthorization,
        idempotency: route.idempotency,
        method: route.method,
        path: route.path,
        successStatus: route.successStatus,
      })),
    );
  });

  test("recognizes every declared route before authentication", async () => {
    const handler = createAgentEmailApiHandler(dependencies({ authenticated: null }).runtime);
    for (const route of AGENT_EMAIL_API_ROUTES) {
      const result = await handler(event(route.method, routePath(route.path)));
      expect(parsed(result)).toMatchObject({
        code: "unauthorized",
        status: 401,
      });
    }
  });

  test("rejects undeclared methods, paths, empty parameters, and encoded separators", async () => {
    const handler = createAgentEmailApiHandler(dependencies().runtime);
    for (const [method, path] of [
      ["DELETE", "/v1/agent-email/inboxes/resource_1"],
      ["GET", "/v1/agent-email/not-declared"],
      ["GET", "/v1/agent-email/inboxes//threads"],
    ]) {
      const result = await handler(event(method!, path!));
      expect(parsed(result)).toMatchObject({
        code: "route_not_found",
        status: 404,
      });
    }
    const encoded = await handler(event("GET", "/v1/agent-email/messages/a%2Fb"));
    expect(parsed(encoded)).toMatchObject({
      code: "invalid_path_parameter",
      status: 400,
    });
  });

  test("dispatches path, query, body, identity, and environment scope", async () => {
    const runtime = dependencies();
    const handler = createAgentEmailApiHandler(runtime.runtime);
    const result = await handler(
      event("POST", "/v1/agent-email/inboxes/inbox%201/messages/search", {
        body: { direction: "inbound", query: "invoice" },
        query: { cursor: "cursor_1", limit: "25" },
      }),
    );

    expect(result.statusCode).toBe(200);
    expect(runtime.calls).toEqual([
      {
        invocation: {
          body: { direction: "inbound", query: "invoice" },
          identity,
          parameters: { inboxId: "inbox 1" },
          query: { cursor: "cursor_1", limit: 25 },
          scope,
        },
        operation: "searchInboxMessages",
      },
    ]);
    expect(runtime.idempotency).toHaveLength(0);
  });

  test("returns the documented messages field from live thread-detail routing", async () => {
    const detail = {
      messages: [{ id: "message_1" }],
      nextCursor: "next",
      thread: { id: "thread_1" },
    };
    const handler = createAgentEmailApiHandler(
      dependencies({
        execute: async (operation) => {
          expect(operation).toBe("getInboxThread");
          return detail;
        },
      }).runtime,
    );

    const result = await handler(event("GET", "/v1/agent-email/inboxes/inbox_1/threads/thread_1"));
    expect(result.statusCode).toBe(200);
    expect(parsed(result)).toEqual(detail);
    expect(parsed(result)).not.toHaveProperty("items");
  });

  test("requires environment scope and honors optional hierarchy assertions", async () => {
    const handler = createAgentEmailApiHandler(dependencies().runtime);
    const missing = await handler(
      event("GET", "/v1/agent-email/inboxes", {
        headers: { "x-deployments-environment": "" },
      }),
    );
    expect(parsed(missing)).toMatchObject({
      code: "missing_scope",
      status: 400,
    });

    const environmentMismatch = await handler(
      event("GET", "/v1/agent-email/inboxes", {
        headers: { "x-deployments-environment": "another_environment" },
      }),
    );
    expect(parsed(environmentMismatch)).toMatchObject({
      code: "environment_scope_violation",
      status: 403,
    });
    const projectMismatch = await handler(
      event("GET", "/v1/agent-email/inboxes", {
        headers: { "x-deployments-project": "another_project" },
      }),
    );
    expect(parsed(projectMismatch)).toMatchObject({
      code: "environment_scope_violation",
      status: 403,
    });
    const environmentOnly = event("GET", "/v1/agent-email/inboxes");
    delete (environmentOnly.headers as Record<string, string>)["x-deployments-organization"];
    delete (environmentOnly.headers as Record<string, string>)["x-deployments-project"];
    expect((await handler(environmentOnly)).statusCode).toBe(200);
  });

  test("enforces read and write permissions", async () => {
    const readOnly = { ...identity, permissions: ["agent-email:read"] };
    const handler = createAgentEmailApiHandler(dependencies({ authenticated: readOnly }).runtime);
    expect((await handler(event("GET", "/v1/agent-email/inboxes"))).statusCode).toBe(200);
    const denied = await handler(
      event("POST", "/v1/agent-email/inboxes", {
        body: {},
        headers: { "idempotency-key": "create-inbox-1" },
      }),
    );
    expect(parsed(denied)).toMatchObject({
      code: "insufficient_scope",
      status: 403,
    });

    const writeOnly = { ...identity, permissions: ["agent-email:write"] };
    const writeHandler = createAgentEmailApiHandler(
      dependencies({ authenticated: writeOnly }).runtime,
    );
    const adminDenied = await writeHandler(
      event("POST", "/v1/agent-email/domains", {
        body: { domain: "agents.example.com" },
        headers: { "idempotency-key": "create-domain-1" },
      }),
    );
    expect(parsed(adminDenied)).toMatchObject({
      code: "insufficient_scope",
      status: 403,
    });
  });
});
