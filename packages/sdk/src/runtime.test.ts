import { describe, expect, test } from "bun:test";
import { createPlatformSdk, PlatformRequestError } from "./index.ts";
import type { CreatePreviewInput } from "./runtime.ts";

function jsonBody(init: RequestInit | undefined): unknown {
  const body = init?.body;
  if (typeof body !== "string") throw new Error("Expected a JSON string request body");
  return JSON.parse(body);
}

describe("platform runtime SDK", () => {
  test("binds workflow execution and approval operations to canonical routes", async () => {
    const requests: Array<{ body?: unknown; headers: Headers; method: string; url: string }> = [];
    const sdk = createPlatformSdk({
      apiKey: "platform-api-key",
      baseUrl: "https://api.example.test",
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({
          ...(init?.body ? { body: jsonBody(init) } : {}),
          headers: new Headers(init?.headers),
          method: String(init?.method),
          url: input instanceof Request ? input.url : String(input),
        });
        return Response.json({ ok: true });
      }) as unknown as typeof fetch,
    });
    const runtime = sdk.runtime({ environmentId: "env", organizationId: "org", projectId: "prj" });

    await runtime.workflowExecutions.list({ cursor: "next", limit: 20, status: "running" });
    await runtime.workflowExecutions.start(
      "release 1",
      { input: { deploy: true }, workspaceId: "workspace_1" },
      { idempotencyKey: "workflow-start-1" },
    );
    await runtime.workflowExecutions.get("execution 1");
    await runtime.workflowExecutions.cancel("execution 1", { expectedVersion: 3 });
    await runtime.workflowExecutions.listSteps("execution 1", { cursor: "steps", limit: 10 });
    await runtime.workflowApprovals.get("execution 1", "approval 1");
    await runtime.workflowApprovals.resolve("execution 1", "approval 1", {
      decision: "approved",
    });

    expect(requests.map(({ method, url }) => [method, url])).toEqual([
      [
        "GET",
        "https://api.example.test/v1/workflow-executions?cursor=next&limit=20&status=running",
      ],
      ["POST", "https://api.example.test/v1/workflow-releases/release%201/executions"],
      ["GET", "https://api.example.test/v1/workflow-executions/execution%201"],
      ["POST", "https://api.example.test/v1/workflow-executions/execution%201/cancel"],
      [
        "GET",
        "https://api.example.test/v1/workflow-executions/execution%201/steps?cursor=steps&limit=10",
      ],
      [
        "GET",
        "https://api.example.test/v1/workflow-executions/execution%201/approvals/approval%201",
      ],
      [
        "POST",
        "https://api.example.test/v1/workflow-executions/execution%201/approvals/approval%201/resolve",
      ],
    ]);
    expect(requests[1]?.headers.get("idempotency-key")).toBe("workflow-start-1");
    expect(requests[1]?.body).toEqual({ input: { deploy: true }, workspaceId: "workspace_1" });
    expect(requests[3]?.body).toEqual({ expectedVersion: 3 });
    expect(requests[6]?.body).toEqual({ decision: "approved" });
  });

  test("binds preview and execution-binding listing operations to canonical routes", async () => {
    const requests: Array<{ body?: unknown; headers: Headers; method: string; url: string }> = [];
    const sdk = createPlatformSdk({
      apiKey: "platform-api-key",
      baseUrl: "https://api.example.test",
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({
          ...(init?.body ? { body: jsonBody(init) } : {}),
          headers: new Headers(init?.headers),
          method: String(init?.method),
          url: input instanceof Request ? input.url : String(input),
        });
        return Response.json({ ok: true });
      }) as unknown as typeof fetch,
    });
    const runtime = sdk.runtime({ environmentId: "env", organizationId: "org", projectId: "prj" });
    const manifest = { name: "draft" } as unknown as CreatePreviewInput["manifest"];

    await runtime.previews.create(
      { fromAgentDeploymentId: "deployment_1", manifest, ttlSeconds: 600 },
      { idempotencyKey: "idem_preview" },
    );
    await runtime.previews.get("preview 1");
    await runtime.previews.submitTurn(
      "preview 1",
      { content: "Try it", threadId: "thread_1" },
      { idempotencyKey: "idem_turn" },
    );
    await runtime.previews.delete("preview 1");
    await runtime.runs.list({ executionBindingId: "preview_1", limit: 5 });
    await runtime.threads.list({ executionBindingId: "preview_1" });

    expect(requests.map(({ method, url }) => [method, url])).toEqual([
      ["POST", "https://api.example.test/v1/previews"],
      ["GET", "https://api.example.test/v1/previews/preview%201"],
      ["POST", "https://api.example.test/v1/previews/preview%201/turns"],
      ["DELETE", "https://api.example.test/v1/previews/preview%201"],
      ["GET", "https://api.example.test/v1/runs?executionBindingId=preview_1&limit=5"],
      ["GET", "https://api.example.test/v1/threads?executionBindingId=preview_1"],
    ]);
    expect(requests[0]?.headers.get("idempotency-key")).toBe("idem_preview");
    expect(requests[0]?.body).toEqual({
      fromAgentDeploymentId: "deployment_1",
      manifest: { name: "draft" },
      ttlSeconds: 600,
    });
    expect(requests[2]?.headers.get("idempotency-key")).toBe("idem_turn");
    expect(requests[2]?.body).toEqual({ content: "Try it", threadId: "thread_1" });
    expect(requests[3]?.headers.get("idempotency-key")).toBeNull();
  });

  test("binds every hosted runtime operation to the canonical route", async () => {
    const requests: Array<{ body?: unknown; headers: Headers; method: string; url: string }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push({
        ...(init?.body ? { body: jsonBody(init) } : {}),
        headers: new Headers(init?.headers),
        method: String(init?.method),
        url,
      });
      if (url.endsWith("/stream-sessions")) {
        return Response.json({
          accessToken: "stream-session-token",
          history: [],
          session: {
            offset: "12",
            readUrl: "https://streams.example.test/v1/threads/thread%201/stream?offset=12",
          },
          streamUrl: "https://streams.example.test/v1/threads/thread%201/stream",
        });
      }
      if (url.includes("/stream?")) {
        return Response.json([{ runId: "run_1", type: "run.completed" }], {
          headers: {
            "stream-closed": "false",
            "stream-cursor": "cursor_2",
            "stream-next-offset": "24",
            "stream-up-to-date": "true",
            "x-request-id": "req_stream",
          },
        });
      }
      return Response.json({ ok: true }, { headers: { "x-request-id": "req_runtime" } });
    }) as unknown as typeof fetch;
    const sdk = createPlatformSdk({
      apiKey: "platform-api-key",
      baseUrl: "https://api.example.test",
      fetch: fetchImpl,
    });
    const runtime = sdk.runtime({
      environmentId: "env_1",
      organizationId: "org_1",
      projectId: "prj_1",
    });

    await runtime.runs.list({
      agentDeploymentId: "deployment_1",
      cursor: "run_cursor",
      limit: 20,
      status: "running",
    });
    await runtime.runs.search({
      agentDeploymentId: "deployment_1",
      createdAfter: "2026-07-25T00:00:00.000Z",
      status: "failed",
      threadId: "thread_1",
    });
    await runtime.runs.submit(
      "deployment 1",
      { content: "Deploy the release", threadId: "thread_1" },
      { idempotencyKey: "idem_run" },
    );
    await runtime.threads.list({ cursor: "thread_cursor", limit: 15 });
    await runtime.threads.create({
      agentDeploymentId: "deployment_1",
      title: "Release follow-up",
      workspaceId: "workspace_1",
    });
    await runtime.threads.get("thread 1");
    await runtime.threads.archive("thread 1");
    await runtime.threads.listMessages("thread 1", { cursor: "cursor_1", limit: 25 });
    const session = await runtime.threads.createStreamSession("thread 1");
    const stream = await runtime.threads.readStreamPage(session.data, {
      live: "long-poll",
      offset: "12",
    });
    await runtime.runs.get("thread 1", "run 1");
    await runtime.runs.getMessage("thread 1", "run 1");
    await runtime.runs.reserveMessagePublication(
      "thread 1",
      "run 1",
      { content: "delivered message" },
      { idempotencyKey: "idem_publication" },
    );
    await runtime.runs.publishMessage(
      "thread 1",
      "run 1",
      { content: "delivered message" },
      { idempotencyKey: "idem_publication" },
    );
    await runtime.runs.releaseMessagePublication(
      "thread 1",
      "run 1",
      { content: "delivered message" },
      { idempotencyKey: "idem_publication" },
    );
    await runtime.runs.cancel("run 1");
    await runtime.runs.retry("run 1");
    await runtime.runs.replay("run 1", { idempotencyKey: "idem_replay" });
    await runtime.approvals.list({ cursor: "approval_cursor", limit: 10, status: "pending" });
    await runtime.approvals.get("run 1", "approval 1");
    await runtime.approvals.resolve("run 1", "approval 1", {
      decision: "approved",
      threadId: "thread_1",
    });
    await runtime.toolCalls.list("run 1", { cursor: "tool_cursor", limit: 30 });
    await runtime.toolCalls.resolve("run 1", "tool 1", {
      externalOperationId: "operation_1",
      outcome: "completed",
      outputSummary: "Done",
      threadId: "thread_1",
    });
    await runtime.webhooks.list({ cursor: "webhook_cursor", limit: 40 });
    await runtime.webhooks.create({
      eventTypes: ["run.completed", "run.failed"],
      name: "Runtime completion",
      resourceFilters: { aggregateTypes: ["run"] },
      url: "https://example.test/hooks/runtime",
    });
    await runtime.webhooks.get("webhook 1");
    await runtime.webhooks.archive("webhook 1");
    await runtime.webhooks.update("webhook 1", { name: "Renamed", resourceFilters: null });
    await runtime.webhooks.disable("webhook 1");
    await runtime.webhooks.enable("webhook 1");
    await runtime.webhooks.rotateSecret("webhook 1", { previousSecretExpiresInSeconds: 0 });
    await runtime.webhooks.test("webhook 1");
    await runtime.webhookDeliveries.list({ cursor: "delivery_cursor", limit: 50 });
    await runtime.webhookDeliveries.list({ status: "failed", webhookId: "webhook_1" });
    await runtime.webhookDeliveries.get("delivery 1");
    await runtime.webhookDeliveries.listAttempts("delivery 1", { limit: 5 });
    await runtime.webhookDeliveries.retry("delivery 1");
    await runtime.artifacts.list({
      cursor: "artifact_cursor",
      limit: 25,
      runId: "run_1",
      threadId: "thread_1",
    });
    await runtime.artifacts.createUpload({
      byteSize: 12,
      contentType: "text/plain",
      fileName: "report.txt",
      name: "Release report",
      sha256: "a".repeat(64),
      type: "report",
    });
    await runtime.artifacts.get("artifact 1");
    await runtime.artifacts.completeUpload("artifact 1");
    await runtime.artifacts.updateRetention("artifact 1", {
      expectedVersion: 1,
      retentionExpiresAt: "2026-08-25T12:00:00.000Z",
    });
    await runtime.artifacts.createAccessUrl("artifact 1", { expiresInSeconds: 300 });
    await runtime.artifacts.list({
      contentType: "image/*",
      createdAfter: "2026-07-25T12:00:00.000Z",
      type: "report",
    });
    await runtime.artifacts.delete("artifact 1");
    await runtime.channelBindings.list({ cursor: "binding_cursor", limit: 15 });
    await runtime.channelBindings.create(
      {
        agentDefinitionId: "definition_1",
        agentDeploymentId: "deployment_1",
        channel: "telegram",
        externalThreadKey: "telegram:chat:123",
        provider: "telegram",
      },
      { idempotencyKey: "idem_binding" },
    );
    await runtime.channelBindings.get("binding 1");
    await runtime.channelBindings.update("binding 1", { externalChannelId: null });
    await runtime.channelBindings.verify("binding 1");
    await runtime.channelBindings.composeDelivery(
      "binding 1",
      {
        content: "Deployment complete.",
        externalThreadKey: "telegram:chat:123",
        runId: "run_1",
        threadId: "thread_1",
      },
      { idempotencyKey: "idem_delivery" },
    );
    await runtime.channelBindings.archive("binding 1");
    await runtime.channelDeliveries.list({ cursor: "delivery_cursor", limit: 20 });
    await runtime.channelDeliveries.get("run 1", "delivery 1");
    await runtime.schedules.list({ cursor: "schedule_cursor", limit: 10 });
    await runtime.schedules.create(
      {
        agentDeploymentId: "deployment_1",
        expression: "rate(1 hour)",
        name: "Hourly",
        prompt: "Check status",
      },
      { idempotencyKey: "idem_schedule" },
    );
    await runtime.schedules.get("schedule 1");
    await runtime.schedules.update("schedule 1", { expression: "rate(2 hours)" });
    await runtime.schedules.pause("schedule 1");
    await runtime.schedules.resume("schedule 1");
    await runtime.schedules.listFires("schedule 1", { cursor: "fire_cursor", limit: 8 });
    await runtime.schedules.fire(
      "schedule 1",
      { fireKey: "fire_1" },
      { idempotencyKey: "idem_schedule_fire" },
    );
    await runtime.schedules.archive("schedule 1");
    await runtime.heartbeats.list({ cursor: "heartbeat_cursor", limit: 5 });
    await runtime.heartbeats.create(
      {
        agentDeploymentId: "deployment_1",
        instructions: "Check status",
        intervalMs: 60_000,
      },
      { idempotencyKey: "idem_heartbeat" },
    );
    await runtime.heartbeats.get("heartbeat 1");
    await runtime.heartbeats.update("heartbeat 1", { intervalMs: 120_000 });
    await runtime.heartbeats.pause("heartbeat 1");
    await runtime.heartbeats.resume("heartbeat 1");
    await runtime.heartbeats.listFires("heartbeat 1", { limit: 6 });
    await runtime.heartbeats.fire(
      "heartbeat 1",
      { agentDeploymentId: "deployment_1", fireKey: "fire_2" },
      { idempotencyKey: "idem_heartbeat_fire" },
    );
    await runtime.heartbeats.archive("heartbeat 1");

    expect(requests.map(({ method, url }) => [method, url])).toEqual([
      [
        "GET",
        "https://api.example.test/v1/runs?agentDeploymentId=deployment_1&cursor=run_cursor&limit=20&status=running",
      ],
      ["POST", "https://api.example.test/v1/runs/search"],
      ["POST", "https://api.example.test/v1/agent-deployments/deployment%201/runs"],
      ["GET", "https://api.example.test/v1/threads?cursor=thread_cursor&limit=15"],
      ["POST", "https://api.example.test/v1/threads"],
      ["GET", "https://api.example.test/v1/threads/thread%201"],
      ["POST", "https://api.example.test/v1/threads/thread%201/archive"],
      ["GET", "https://api.example.test/v1/threads/thread%201/messages?cursor=cursor_1&limit=25"],
      ["POST", "https://api.example.test/v1/threads/thread%201/stream-sessions"],
      ["GET", "https://streams.example.test/v1/threads/thread%201/stream?live=long-poll&offset=12"],
      ["GET", "https://api.example.test/v1/threads/thread%201/runs/run%201"],
      ["GET", "https://api.example.test/v1/threads/thread%201/runs/run%201/message"],
      [
        "POST",
        "https://api.example.test/v1/threads/thread%201/runs/run%201/message/publication-reservations",
      ],
      ["POST", "https://api.example.test/v1/threads/thread%201/runs/run%201/message/publications"],
      [
        "POST",
        "https://api.example.test/v1/threads/thread%201/runs/run%201/message/publication-releases",
      ],
      ["POST", "https://api.example.test/v1/runs/run%201/cancel"],
      ["POST", "https://api.example.test/v1/runs/run%201/retry"],
      ["POST", "https://api.example.test/v1/runs/run%201/replay"],
      [
        "GET",
        "https://api.example.test/v1/approvals?cursor=approval_cursor&limit=10&status=pending",
      ],
      ["GET", "https://api.example.test/v1/runs/run%201/approvals/approval%201"],
      ["POST", "https://api.example.test/v1/runs/run%201/approvals/approval%201/resolve"],
      ["GET", "https://api.example.test/v1/runs/run%201/tool-calls?cursor=tool_cursor&limit=30"],
      ["POST", "https://api.example.test/v1/runs/run%201/tool-calls/tool%201/results"],
      ["GET", "https://api.example.test/v1/webhooks?cursor=webhook_cursor&limit=40"],
      ["POST", "https://api.example.test/v1/webhooks"],
      ["GET", "https://api.example.test/v1/webhooks/webhook%201"],
      ["POST", "https://api.example.test/v1/webhooks/webhook%201/archive"],
      ["PATCH", "https://api.example.test/v1/webhooks/webhook%201"],
      ["POST", "https://api.example.test/v1/webhooks/webhook%201/disable"],
      ["POST", "https://api.example.test/v1/webhooks/webhook%201/enable"],
      ["POST", "https://api.example.test/v1/webhooks/webhook%201/rotate-secret"],
      ["POST", "https://api.example.test/v1/webhooks/webhook%201/test"],
      ["GET", "https://api.example.test/v1/webhook-deliveries?cursor=delivery_cursor&limit=50"],
      ["GET", "https://api.example.test/v1/webhook-deliveries?status=failed&webhookId=webhook_1"],
      ["GET", "https://api.example.test/v1/webhook-deliveries/delivery%201"],
      ["GET", "https://api.example.test/v1/webhook-deliveries/delivery%201/attempts?limit=5"],
      ["POST", "https://api.example.test/v1/webhook-deliveries/delivery%201/retry"],
      [
        "GET",
        "https://api.example.test/v1/artifacts?cursor=artifact_cursor&limit=25&runId=run_1&threadId=thread_1",
      ],
      ["POST", "https://api.example.test/v1/artifacts"],
      ["GET", "https://api.example.test/v1/artifacts/artifact%201"],
      ["POST", "https://api.example.test/v1/artifacts/artifact%201/complete"],
      ["PATCH", "https://api.example.test/v1/artifacts/artifact%201/retention"],
      ["POST", "https://api.example.test/v1/artifacts/artifact%201/access-urls"],
      [
        "GET",
        "https://api.example.test/v1/artifacts?contentType=image%2F*&createdAfter=2026-07-25T12%3A00%3A00.000Z&type=report",
      ],
      ["DELETE", "https://api.example.test/v1/artifacts/artifact%201"],
      ["GET", "https://api.example.test/v1/channel-bindings?cursor=binding_cursor&limit=15"],
      ["POST", "https://api.example.test/v1/channel-bindings"],
      ["GET", "https://api.example.test/v1/channel-bindings/binding%201"],
      ["PATCH", "https://api.example.test/v1/channel-bindings/binding%201"],
      ["POST", "https://api.example.test/v1/channel-bindings/binding%201/verify"],
      ["POST", "https://api.example.test/v1/channel-bindings/binding%201/deliveries"],
      ["DELETE", "https://api.example.test/v1/channel-bindings/binding%201"],
      ["GET", "https://api.example.test/v1/channel-deliveries?cursor=delivery_cursor&limit=20"],
      ["GET", "https://api.example.test/v1/runs/run%201/channel-deliveries/delivery%201"],
      ["GET", "https://api.example.test/v1/schedules?cursor=schedule_cursor&limit=10"],
      ["POST", "https://api.example.test/v1/schedules"],
      ["GET", "https://api.example.test/v1/schedules/schedule%201"],
      ["PATCH", "https://api.example.test/v1/schedules/schedule%201"],
      ["POST", "https://api.example.test/v1/schedules/schedule%201/pause"],
      ["POST", "https://api.example.test/v1/schedules/schedule%201/resume"],
      [
        "GET",
        "https://api.example.test/v1/schedules/schedule%201/fires?cursor=fire_cursor&limit=8",
      ],
      ["POST", "https://api.example.test/v1/schedules/schedule%201/fire"],
      ["DELETE", "https://api.example.test/v1/schedules/schedule%201"],
      ["GET", "https://api.example.test/v1/heartbeats?cursor=heartbeat_cursor&limit=5"],
      ["POST", "https://api.example.test/v1/heartbeats"],
      ["GET", "https://api.example.test/v1/heartbeats/heartbeat%201"],
      ["PATCH", "https://api.example.test/v1/heartbeats/heartbeat%201"],
      ["POST", "https://api.example.test/v1/heartbeats/heartbeat%201/pause"],
      ["POST", "https://api.example.test/v1/heartbeats/heartbeat%201/resume"],
      ["GET", "https://api.example.test/v1/heartbeats/heartbeat%201/fires?limit=6"],
      ["POST", "https://api.example.test/v1/heartbeats/heartbeat%201/fire"],
      ["DELETE", "https://api.example.test/v1/heartbeats/heartbeat%201"],
    ]);
    expect(requests[1]?.body).toEqual({
      agentDeploymentId: "deployment_1",
      createdAfter: "2026-07-25T00:00:00.000Z",
      status: "failed",
      threadId: "thread_1",
    });
    expect(requests[2]?.body).toEqual({
      content: "Deploy the release",
      threadId: "thread_1",
    });
    expect(requests[2]?.headers.get("idempotency-key")).toBe("idem_run");
    expect(requests[4]?.headers.get("idempotency-key")).toBeNull();
    expect(requests[8]?.headers.get("authorization")).toBe("Bearer platform-api-key");
    expect(requests[9]?.headers.get("authorization")).toBe("Bearer stream-session-token");
    expect(requests[9]?.headers.get("x-deployments-environment")).toBeNull();
    expect(requests[12]?.body).toEqual({ content: "delivered message" });
    expect(requests[12]?.headers.get("idempotency-key")).toBe("idem_publication");
    expect(requests[13]?.headers.get("idempotency-key")).toBe("idem_publication");
    expect(requests[14]?.headers.get("idempotency-key")).toBe("idem_publication");
    expect(requests[17]?.headers.get("idempotency-key")).toBe("idem_replay");
    expect(requests[20]?.body).toEqual({ decision: "approved", threadId: "thread_1" });
    expect(requests[22]?.body).toEqual({
      externalOperationId: "operation_1",
      outcome: "completed",
      outputSummary: "Done",
      threadId: "thread_1",
    });
    expect(requests[24]?.body).toEqual({
      eventTypes: ["run.completed", "run.failed"],
      name: "Runtime completion",
      resourceFilters: { aggregateTypes: ["run"] },
      url: "https://example.test/hooks/runtime",
    });
    expect(requests[24]?.headers.get("idempotency-key")).toBeNull();
    expect(requests[27]?.body).toEqual({ name: "Renamed", resourceFilters: null });
    expect(requests[30]?.body).toEqual({ previousSecretExpiresInSeconds: 0 });
    expect(requests[38]?.body).toEqual({
      byteSize: 12,
      contentType: "text/plain",
      fileName: "report.txt",
      name: "Release report",
      sha256: "a".repeat(64),
      type: "report",
    });
    expect(requests[38]?.headers.get("idempotency-key")).toBeNull();
    expect(requests[40]?.headers.get("idempotency-key")).toBeNull();
    expect(requests[41]?.body).toEqual({
      expectedVersion: 1,
      retentionExpiresAt: "2026-08-25T12:00:00.000Z",
    });
    expect(requests[41]?.headers.get("idempotency-key")).toBeNull();
    expect(stream).toEqual({
      closed: false,
      cursor: "cursor_2",
      items: [{ runId: "run_1", type: "run.completed" }],
      nextOffset: "24",
      requestId: "req_stream",
      upToDate: true,
    });
  });

  test("rejects missing runtime mutation idempotency before transport", async () => {
    let requests = 0;
    const sdk = createPlatformSdk({
      apiKey: "platform-api-key",
      baseUrl: "https://api.example.test",
      fetch: (async () => {
        requests += 1;
        return Response.json({ ok: true });
      }) as unknown as typeof fetch,
    });
    const runtime = sdk.runtime({});

    // Each call below omits the required mutation options the way an untyped JavaScript caller can.
    expect(
      // @ts-expect-error -- missing mutation options
      runtime.runs.submit("deployment_1", { content: "Deploy the release" }),
    ).rejects.toBeInstanceOf(PlatformRequestError);
    expect(
      // @ts-expect-error -- missing mutation options
      runtime.schedules.create({
        agentDeploymentId: "deployment_1",
        expression: "rate(1 hour)",
        name: "Hourly",
        prompt: "Check status",
      }),
    ).rejects.toBeInstanceOf(PlatformRequestError);
    // @ts-expect-error -- missing fire key and mutation options
    expect(runtime.schedules.fire("schedule_1")).rejects.toBeInstanceOf(PlatformRequestError);
    // @ts-expect-error -- missing mutation options
    expect(runtime.runs.replay("run_1")).rejects.toBeInstanceOf(PlatformRequestError);
    expect(
      // @ts-expect-error -- missing mutation options
      runtime.channelBindings.create({
        agentDefinitionId: "definition_1",
        agentDeploymentId: "deployment_1",
        channel: "telegram",
        provider: "telegram",
      }),
    ).rejects.toBeInstanceOf(PlatformRequestError);
    expect(
      // @ts-expect-error -- missing mutation options
      runtime.channelBindings.composeDelivery("binding_1", {
        content: "Done",
        externalThreadKey: "telegram:chat:123",
        runId: "run_1",
        threadId: "thread_1",
      }),
    ).rejects.toBeInstanceOf(PlatformRequestError);
    expect(
      // @ts-expect-error -- incomplete manifest and missing mutation options
      runtime.previews.create({ manifest: {} }),
    ).rejects.toBeInstanceOf(PlatformRequestError);
    expect(
      // @ts-expect-error -- missing mutation options
      runtime.previews.submitTurn("preview_1", { content: "x" }),
    ).rejects.toBeInstanceOf(PlatformRequestError);
    expect(requests).toBe(0);
  });
});
