import { createExecutionBindingService } from "@deployments-ai/conversations";
import { makeManifestModelAdmission, type Ulid } from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { handlePreviewRoutes } from "./preview-routes.ts";
import { handleRunThreadRoutes } from "./run-thread-routes.ts";
import type { RuntimeRouteContext } from "./runtime-handler.ts";
import {
  deployment,
  memoryDatabase,
  now,
  principal as platformPrincipal,
} from "./runtime-lifecycle.fixture.ts";
import {
  runtimeApiErrorFromCause,
  type HttpApiEvent,
  type RuntimeApiDependencies,
  type RuntimeApiPrincipal,
} from "./runtime-support.ts";

const manifest = {
  apiVersion: "agents.deployments.ai/v1",
  kind: "Agent",
  metadata: { key: "example.preview", name: "Preview Assistant", version: "1.0.0" },
  spec: {
    instructions: "Answer briefly.",
    model: { id: "openrouter/qwen/qwen3.7-plus" },
    sandbox: { mode: "none" },
  },
};

function harness(scopes: readonly string[] = ["platform:*"]) {
  const memory = memoryDatabase([deployment()]);
  const enqueued: unknown[] = [];
  let sequence = 0;
  let clock = now;
  const dependencies = {
    admitManifest: makeManifestModelAdmission(memory.database),
    database: memory.database,
    durableTransport: {
      append: async () => ({}),
      currentOffset: async () => "0",
    },
    enqueueRun: async (input: unknown) => {
      enqueued.push(input);
    },
    generateId: async () =>
      `01ARZ3NDEKTSV4RRFFQ69G7${String((sequence += 1)).padStart(3, "0")}` as Ulid,
    now: () => clock,
    sessionTokenSecret: "runtime-api-test-secret".repeat(2),
  } as unknown as RuntimeApiDependencies;
  const base = platformPrincipal();
  const principal = {
    ...base,
    credential: { data: { ...base.credential.data, scopes } },
    serviceAccount: { data: { ...base.serviceAccount.data, scopes } },
  } as unknown as RuntimeApiPrincipal;

  async function call(
    method: string,
    path: string,
    options: {
      readonly body?: Readonly<Record<string, unknown>>;
      readonly idempotencyKey?: string;
      readonly query?: Readonly<Record<string, string>>;
    } = {},
  ) {
    const event: HttpApiEvent = {
      headers: options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {},
      rawPath: path,
      requestContext: { http: { method } },
      ...(options.query ? { queryStringParameters: options.query } : {}),
    };
    const context: RuntimeRouteContext = {
      body: options.body ?? {},
      dependencies,
      event,
      method,
      path,
      principal,
    };
    try {
      const result = (await handlePreviewRoutes(context)) ?? (await handleRunThreadRoutes(context));
      if (!result) throw new Error(`Unhandled route ${method} ${path}`);
      return { body: JSON.parse(result.body ?? "{}"), status: result.statusCode };
    } catch (cause) {
      const error = runtimeApiErrorFromCause(cause);
      return { body: { code: error.code }, status: error.status };
    }
  }

  return {
    advance: (milliseconds: number) => {
      clock = new Date(clock.getTime() + milliseconds);
    },
    call,
    createPreview: (body: Readonly<Record<string, unknown>> = { manifest }) =>
      call("POST", "/v1/previews", { body, idempotencyKey: "preview-create" }),
    dependencies,
    enqueued,
  };
}

describe("preview routes", () => {
  test("creates an active preview of an inline manifest with the default TTL", async () => {
    const subject = harness();
    const created = await subject.createPreview();

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      agentName: "Preview Assistant",
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000).toISOString(),
      object: "preview",
      status: "active",
    });
    expect(created.body.manifest).toBeUndefined();

    const replay = await subject.createPreview();
    expect(replay.body.id).toBe(created.body.id);
    const fetched = await subject.call("GET", `/v1/previews/${created.body.id}`);
    expect(fetched).toMatchObject({ body: { id: created.body.id }, status: 200 });
  });

  test("rejects invalid bodies, conflicting runtime config sources, and missing agents:write", async () => {
    const subject = harness();
    expect(await subject.createPreview({})).toMatchObject({ status: 400 });
    expect(await subject.createPreview({ manifest, ttlSeconds: 30 })).toMatchObject({
      status: 400,
    });
    expect(
      await subject.createPreview({
        fromAgentDeploymentId: deployment().data.id,
        manifest,
        runtimeConfig: { apiVersion: "agents.deployments.ai/v1", kind: "AgentDeploymentConfig" },
      }),
    ).toMatchObject({ body: { code: "invalid_request" }, status: 400 });
    expect(await subject.call("POST", "/v1/previews", { body: { manifest } })).toMatchObject({
      body: { code: "idempotency_key_required" },
      status: 400,
    });

    const runsOnly = harness(["runs:read", "runs:write"]);
    expect(await runsOnly.createPreview()).toMatchObject({
      body: { code: "insufficient_scope" },
      status: 403,
    });
  });

  test("rejects a manifest model the environment model policy does not admit with 422", async () => {
    const subject = harness();
    const denied = await subject.createPreview({
      manifest: {
        ...manifest,
        spec: { ...manifest.spec, model: { id: "openrouter/vendor/unlisted" } },
      },
    });

    expect(denied).toMatchObject({
      body: { code: "model_not_allowed_by_environment_policy" },
      status: 422,
    });
    expect((await subject.createPreview()).status).toBe(201);
  });

  test("accepts a turn as a preview run readable through the run and thread routes", async () => {
    const subject = harness();
    const preview = (await subject.createPreview()).body;
    const turn = await subject.call("POST", `/v1/previews/${preview.id}/turns`, {
      body: { content: "Hello preview." },
      idempotencyKey: "turn-1",
    });

    expect(turn.status).toBe(202);
    expect(turn.body.run).toMatchObject({
      executionBindingId: preview.id,
      executionPurpose: "preview",
      status: "queued",
    });
    expect(turn.body.run.agentDeploymentId).toBeUndefined();
    expect(turn.body.thread).toMatchObject({
      executionBindingId: preview.id,
      executionPurpose: "preview",
    });
    expect(subject.enqueued).toHaveLength(1);

    const threadId = turn.body.thread.id;
    expect(await subject.call("GET", `/v1/threads/${threadId}`)).toMatchObject({
      body: { executionPurpose: "preview", id: threadId },
      status: 200,
    });
    expect(
      await subject.call("GET", `/v1/threads/${threadId}/runs/${turn.body.run.id}`),
    ).toMatchObject({ body: { executionPurpose: "preview" }, status: 200 });

    const followUp = await subject.call("POST", `/v1/previews/${preview.id}/turns`, {
      body: { content: "Second turn.", threadId },
      idempotencyKey: "turn-2",
    });
    expect(followUp).toMatchObject({ body: { thread: { id: threadId } }, status: 202 });
  });

  test("expires a deleted preview so later turns conflict", async () => {
    const subject = harness();
    const preview = (await subject.createPreview()).body;
    const deleted = await subject.call("DELETE", `/v1/previews/${preview.id}`);

    expect(deleted).toMatchObject({ body: { status: "expired" }, status: 200 });
    expect(deleted.body.expiredAt).toBe(now.toISOString());
    expect(
      await subject.call("POST", `/v1/previews/${preview.id}/turns`, {
        body: { content: "Too late." },
        idempotencyKey: "turn-late",
      }),
    ).toMatchObject({ body: { code: "execution_binding_expired" }, status: 409 });
  });

  test("reports a preview past its TTL as expired", async () => {
    const subject = harness();
    const preview = (await subject.createPreview({ manifest, ttlSeconds: 60 })).body;
    subject.advance(60_000);

    expect(await subject.call("GET", `/v1/previews/${preview.id}`)).toMatchObject({
      body: { status: "expired" },
      status: 200,
    });
    expect(
      await subject.call("POST", `/v1/previews/${preview.id}/turns`, {
        body: { content: "Expired." },
        idempotencyKey: "turn-expired",
      }),
    ).toMatchObject({ status: 409 });
  });

  test("does not expose evaluation bindings as previews", async () => {
    const subject = harness();
    const scope = platformPrincipal().scope;
    const { binding } = await createExecutionBindingService(
      subject.dependencies,
    ).createExecutionBinding({
      ...scope,
      createdBy: { id: platformPrincipal().serviceAccount.data.id, type: "service-account" },
      idempotencyKey: "evaluation",
      purpose: "evaluation",
      source: { manifest, type: "manifest" },
      toolPolicy: "evaluation",
      ttlSeconds: 600,
    });

    for (const [method, path] of [
      ["GET", `/v1/previews/${binding.data.id}`],
      ["DELETE", `/v1/previews/${binding.data.id}`],
    ] as const) {
      expect(await subject.call(method, path)).toMatchObject({ status: 404 });
    }
    expect(
      await subject.call("POST", `/v1/previews/${binding.data.id}/turns`, {
        body: { content: "Hello." },
        idempotencyKey: "turn-evaluation",
      }),
    ).toMatchObject({ status: 404 });
  });
});

describe("preview run and thread listings", () => {
  async function previewWithTurn() {
    const subject = harness();
    const preview = (await subject.createPreview()).body;
    const turn = (
      await subject.call("POST", `/v1/previews/${preview.id}/turns`, {
        body: { content: "List me." },
        idempotencyKey: "turn-list",
      })
    ).body;
    return { preview, subject, turn };
  }

  test("accepts at most one run owner filter", async () => {
    const { preview, subject, turn } = await previewWithTurn();

    // Without an owner filter the environment-wide run feed answers instead.
    expect(await subject.call("GET", "/v1/runs", { query: {} })).toMatchObject({ status: 200 });
    expect(
      await subject.call("GET", "/v1/runs", {
        query: { agentDeploymentId: deployment().data.id, executionBindingId: preview.id },
      }),
    ).toMatchObject({ status: 400 });

    const bound = await subject.call("GET", "/v1/runs", {
      query: { executionBindingId: preview.id },
    });
    expect(bound.status).toBe(200);
    expect(bound.body.runs.map((run: { id: string }) => run.id)).toEqual([turn.run.id]);

    const customer = await subject.call("GET", "/v1/runs", {
      query: { agentDeploymentId: deployment().data.id },
    });
    expect(customer.body.runs).toEqual([]);
  });

  test("excludes preview threads unless the execution binding filter is set", async () => {
    const { preview, subject, turn } = await previewWithTurn();

    const environment = await subject.call("GET", "/v1/threads", { query: {} });
    expect(environment.body.threads).toEqual([]);

    const bound = await subject.call("GET", "/v1/threads", {
      query: { executionBindingId: preview.id },
    });
    expect(bound.body.threads).toEqual([
      expect.objectContaining({ executionPurpose: "preview", id: turn.thread.id }),
    ]);
  });
});
