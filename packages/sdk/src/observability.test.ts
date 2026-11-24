import { expect, test } from "bun:test";
import { createMockPlatformSdk, createPlatformSdk } from "./index.ts";

test("observability SDK applies scope and bounded trace filters", async () => {
  let request: Request | undefined;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    request =
      input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
    return Response.json({ items: [] }, { headers: { "x-request-id": "request-1" } });
  }) as unknown as typeof fetch;
  const sdk = createPlatformSdk({
    apiKey: "credential",
    baseUrl: "https://api.example.test",
    fetch: fetchImpl,
  });
  const response = await sdk
    .observability({
      environmentId: "environment-1",
      organizationId: "organization-1",
      projectId: "project-1",
      workspaceId: "workspace-1",
    })
    .listTraces({ limit: 25, status: "error" });
  expect(response.requestId).toBe("request-1");
  expect(request?.url).toBe(
    "https://api.example.test/v1/observability/traces?limit=25&status=error",
  );
  expect(request?.headers.get("x-deployments-organization")).toBe("organization-1");
  expect(request?.headers.get("x-deployments-workspace")).toBe("workspace-1");

  await sdk
    .observability({
      environmentId: "environment-1",
      organizationId: "organization-1",
      projectId: "project-1",
      workspaceId: "workspace-1",
    })
    .listTraceSpans("trace-1", { cursor: "cursor-1", limit: 50 });
  expect(request?.url).toBe(
    "https://api.example.test/v1/observability/traces/trace-1/spans?cursor=cursor-1&limit=50",
  );

  const scoped = sdk.observability({ organizationId: "organization-1" });
  await scoped.metrics({ groupBy: "model", interval: "day", from: "2026-08-01T00:00:00.000Z" });
  expect(request?.url).toBe(
    "https://api.example.test/v1/observability/metrics?from=2026-08-01T00%3A00%3A00.000Z&groupBy=model&interval=day",
  );
  await scoped.tools({ agentDeploymentId: "deployment-1" });
  expect(request?.url).toBe(
    "https://api.example.test/v1/observability/tools?agentDeploymentId=deployment-1",
  );
  await scoped.listTraces({ agentReleaseId: "release-1", executionPurpose: "preview" });
  expect(request?.url).toBe(
    "https://api.example.test/v1/observability/traces?agentReleaseId=release-1&executionPurpose=preview",
  );
});

test("observability mock SDK returns route-shaped fixtures", async () => {
  const observability = createMockPlatformSdk({
    now: () => new Date("2026-08-03T00:00:00.000Z"),
  }).observability({
    environmentId: "environment-1",
    organizationId: "organization-1",
    projectId: "project-1",
  });
  const traces = await observability.listTraces();
  expect(traces.data.items[0]).toMatchObject({
    status: "ok",
    total_tokens: 12,
  });
  expect((await observability.getTrace("trace-custom")).data.trace_id).toBe("trace-custom");
  expect((await observability.listTraceSpans("trace-custom")).data.items[0]).toMatchObject({
    span_id: "0123456789abcdef",
    trace_id: "trace-custom",
  });
  expect((await observability.getRunTrace("run-custom")).data.run_id).toBe("run-custom");
  expect((await observability.listSessionTraces("session-custom")).data.items).toHaveLength(1);
  expect((await observability.metrics()).data.items[0]).toHaveProperty("trace_count", 1);
  expect((await observability.tools()).data.items[0]).toHaveProperty("name", "mock.tool");
  expect((await observability.exportTraces(1)).data).toMatchObject({
    generatedAt: "2026-08-03T00:00:00.000Z",
  });
});
