import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  ComposeChannelDeliveryRequest,
  CreateChannelBindingRequest,
  CreateArtifactAccessUrlRequest,
  CreateArtifactUploadRequest,
  CreateHeartbeatRequest,
  CreateScheduleRequest,
  CreateThreadRequest,
  CreateWebhookSubscriptionRequest,
  FireAutomationRequest,
  FireHeartbeatRequest,
  ResolveToolResultRequest,
  RUNTIME_API_ROUTES,
  STREAM_GATEWAY_API_ROUTES,
  RuntimeListQuery,
  RuntimeIdempotencyKey,
  SearchRunsRequest,
  SubmitAgentRunRequest,
  UpdateChannelBindingRequest,
  UpdateArtifactRetentionRequest,
} from "./runtime.ts";

describe("runtime API contract", () => {
  test("matches heartbeat interval and active-window runtime validation", () => {
    const decode = Schema.decodeUnknownSync(CreateHeartbeatRequest);
    expect(
      decode({
        activeWindow: { endMinuteOfDay: 1020, startMinuteOfDay: 540 },
        agentDeploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        instructions: "Check work",
        intervalMs: 60_000,
        threadId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      }),
    ).toMatchObject({ threadId: "01ARZ3NDEKTSV4RRFFQ69G5FAW" });
    expect(() =>
      decode({
        activeWindow: {},
        agentDeploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        instructions: "Check work",
        intervalMs: 61_000,
      }),
    ).toThrow();
    expect(() =>
      decode({
        activeWindow: {
          daysOfWeek: [1, 1],
          endMinuteOfDay: 1020,
          startMinuteOfDay: 540,
        },
        agentDeploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        instructions: "Check work",
      }),
    ).toThrow();
  });

  test("validates channel binding creation, nullable updates, and delivery composition", () => {
    const binding = {
      agentDefinitionId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      agentDeploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      channel: "telegram",
      externalChannelId: "bot-1",
      externalThreadKey: "telegram:chat:123",
      metadata: { audience: "operations" },
      provider: "telegram",
    } as const;
    expect(() => Schema.decodeUnknownSync(CreateChannelBindingRequest)(binding)).not.toThrow();
    expect(() =>
      Schema.decodeUnknownSync(CreateChannelBindingRequest)({
        ...binding,
        channel: "rcs",
        externalChannelId: "arn:aws:sms-voice:us-east-2:123456789012:rcs-agent/rcs-agent-1",
        provider: "aws_end_user_messaging_rcs",
      }),
    ).not.toThrow();
    expect(() =>
      Schema.decodeUnknownSync(CreateChannelBindingRequest)({
        ...binding,
        channel: "teams",
        externalAccountId: "00000000-0000-4000-8000-000000000001",
        externalChannelId: "19:abc@thread.tacv2",
        externalThreadKey: "teams:tenant-1:thread:19:abc@thread.tacv2;messageid=1",
        externalWorkspaceId: "tenant-1",
        metadata: { teamsAgentIdentity: { displayName: "Rex" } },
        provider: "teams_bot_framework",
      }),
    ).not.toThrow();
    expect(() =>
      Schema.decodeUnknownSync(CreateChannelBindingRequest)({
        ...binding,
        externalChannelId: " padded",
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(CreateChannelBindingRequest)({
        ...binding,
        provider: "unsupported",
      }),
    ).toThrow();

    expect(
      Schema.decodeUnknownSync(UpdateChannelBindingRequest)({
        agentDeploymentId: null,
        connectionId: null,
        externalAccountId: null,
        externalChannelId: null,
        externalThreadKey: null,
        externalWorkspaceId: null,
        metadata: null,
      }),
    ).toEqual({
      agentDeploymentId: null,
      connectionId: null,
      externalAccountId: null,
      externalChannelId: null,
      externalThreadKey: null,
      externalWorkspaceId: null,
      metadata: null,
    });

    const compose = {
      content: "Deployment complete.",
      externalThreadKey: "telegram:chat:123",
      rcsMessage: { TimeToLive: 600 },
      runId: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
      threadId: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
    };
    expect(() => Schema.decodeUnknownSync(ComposeChannelDeliveryRequest)(compose)).not.toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ComposeChannelDeliveryRequest)({
        ...compose,
        rcsMessage: { TimeToLive: 172_801 },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(ComposeChannelDeliveryRequest)({
        ...compose,
        content: "x".repeat(40_001),
      }),
    ).toThrow();
  });

  test("bounds runtime idempotency keys by worker-compatible UTF-8 bytes", () => {
    const decode = Schema.decodeUnknownSync(RuntimeIdempotencyKey);
    expect(() => decode("x".repeat(256))).not.toThrow();
    expect(() => decode("x".repeat(257))).toThrow();
    expect(() => decode("line\nbreak")).toThrow();
    expect(() => decode(" ")).toThrow();
    expect(() => decode(" padded")).toThrow();
  });

  test("advertises idempotency for replay and automation mutation routes", () => {
    for (const name of [
      "replayRun",
      "createSchedule",
      "fireSchedule",
      "createHeartbeat",
      "fireHeartbeat",
      "publishRunMessage",
      "releaseRunMessagePublication",
      "reserveRunMessagePublication",
    ]) {
      const route = RUNTIME_API_ROUTES.find((candidate) => candidate.name === name);
      expect(route && "idempotent" in route ? route.idempotent : false).toBe(true);
    }
    expect(
      Object.fromEntries(
        RUNTIME_API_ROUTES.filter((route) => route.idempotency !== "none").map((route) => [
          route.name,
          route.idempotency,
        ]),
      ),
    ).toEqual({
      composeChannelDelivery: "required",
      createChannelBinding: "required",
      createHeartbeat: "required",
      createPreview: "required",
      createSchedule: "required",
      fireHeartbeat: "required-or-body",
      fireSchedule: "required-or-body",
      publishRunMessage: "required",
      releaseRunMessagePublication: "required",
      replayRun: "required",
      reserveRunMessagePublication: "required",
      startWorkflowExecution: "required",
      submitAgentRun: "required",
      submitPreviewTurn: "required",
    });
  });

  test("serves session-token stream reads from the stream gateway, not the runtime API", () => {
    expect(RUNTIME_API_ROUTES.map((route) => route.name)).not.toContain("readThreadStream");
    const route = STREAM_GATEWAY_API_ROUTES.find(
      (candidate) => candidate.name === "readThreadStream",
    );
    expect(route).toMatchObject({
      authentication: "stream-session",
      method: "GET",
      path: "/v1/threads/:threadId/stream",
      requiredPermission: "read",
      server: "stream-gateway",
    });
    expect(route?.queryParameters.find((parameter) => parameter.name === "live")?.schema).toEqual({
      enum: ["long-poll", "sse"],
      type: "string",
    });
  });

  test("declares history snapshot conflicts while external delivery is unresolved", () => {
    for (const name of ["listThreadMessages", "createThreadStreamSession"]) {
      expect(RUNTIME_API_ROUTES.find((route) => route.name === name)?.errors).toContain(409);
    }
  });

  test("models manual automation fire bodies and header alternatives", () => {
    const decodeFire = Schema.decodeUnknownSync(FireAutomationRequest);
    expect(decodeFire({})).toEqual({});
    expect(decodeFire({ fireKey: "manual-fire-1" })).toEqual({
      fireKey: "manual-fire-1",
    });
    expect(() => decodeFire({ fireKey: " padded" })).toThrow();

    const decodeHeartbeatFire = Schema.decodeUnknownSync(FireHeartbeatRequest);
    const heartbeatFire = decodeHeartbeatFire({
      agentDeploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      fireKey: "heartbeat-fire-1",
    });
    expect(String(heartbeatFire.agentDeploymentId)).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(heartbeatFire.fireKey).toBe("heartbeat-fire-1");
    expect(() => decodeHeartbeatFire({ fireKey: "heartbeat-fire-1" })).toThrow();
  });

  test("bounds tool result correlation and structured output", () => {
    const decode = Schema.decodeUnknownSync(ResolveToolResultRequest);
    const request = {
      outcome: "completed",
      threadId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    } as const;
    expect(() => decode(request)).not.toThrow();
    expect(() => decode({ ...request, externalOperationId: "provider-operation-1" })).not.toThrow();
    expect(() => decode({ ...request, externalOperationId: "unknown:reserved" })).toThrow();
    expect(() => decode({ ...request, externalOperationId: "x".repeat(513) })).toThrow();
    expect(() =>
      decode({
        ...request,
        externalOperationId: "provider-operation-1",
        outputSummary: "x".repeat(1_001),
      }),
    ).toThrow();
    expect(decode({ ...request, output: { temperature: 21.5, unit: "C" } }).output).toEqual({
      temperature: 21.5,
      unit: "C",
    });
    expect(() => decode({ ...request, output: ["not", "an", "object"] })).toThrow();
    expect(() => decode({ ...request, output: { text: "x".repeat(96 * 1024) } })).toThrow();
    expect(() =>
      decode({ ...request, output: { text: "x".repeat(96 * 1024 - 20) } }),
    ).not.toThrow();
  });

  test("matches conversation request text limits", () => {
    const decode = Schema.decodeUnknownSync(SubmitAgentRunRequest);
    const request = { content: "Run the deployment" };
    expect(() => decode(request)).not.toThrow();
    expect(() => decode({ ...request, title: "x".repeat(120) })).not.toThrow();
    expect(() => decode({ ...request, title: "x".repeat(121) })).toThrow();
    expect(() => decode({ content: " " })).toThrow();
    expect(() => decode({ content: "\u{1f600}".repeat(65_537) })).toThrow();
    expect(() => decode({ ...request, runContext: "Current structured state" })).not.toThrow();
    expect(() => decode({ ...request, runContext: " context " })).toThrow();
    expect(() => decode({ ...request, runContext: "\u{1f600}".repeat(65_537) })).toThrow();
    expect(() => decode({ ...request, responsePublication: "external" })).not.toThrow();
    expect(() => decode({ ...request, responsePublication: "immediate" })).toThrow();
  });

  test("validates run search, independent threads, and webhook subscriptions", () => {
    const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const searchRuns = Schema.decodeUnknownSync(SearchRunsRequest);
    expect(() =>
      searchRuns({
        agentDeploymentId: id,
        createdAfter: "2026-07-25T00:00:00.000Z",
        createdBefore: "2026-07-26T00:00:00.000Z",
        status: "waiting-for-approval",
        threadId: id,
      }),
    ).not.toThrow();
    expect(() => searchRuns({ executionPurpose: "evaluation", status: "completed" })).not.toThrow();
    expect(() => searchRuns({ agentDeploymentId: id, executionBindingId: id })).toThrow();
    expect(() => searchRuns({ executionPurpose: "internal" })).toThrow();
    expect(() => searchRuns({ agentDeploymentId: id, status: "unknown" })).toThrow();
    expect(() => searchRuns({ agentDeploymentId: id, createdAfter: "yesterday" })).toThrow();

    const createThread = Schema.decodeUnknownSync(CreateThreadRequest);
    expect(() =>
      createThread({
        agentDeploymentId: id,
        continueFromThreadId: id,
        title: "Release follow-up",
        workspaceId: id,
      }),
    ).not.toThrow();
    expect(() => createThread({ agentDeploymentId: id, title: "x".repeat(121) })).toThrow();
    expect(() => createThread({ agentDeploymentId: id, channel: "console" })).not.toThrow();
    expect(() => createThread({ agentDeploymentId: id, channel: "slack" })).toThrow();

    const createWebhook = Schema.decodeUnknownSync(CreateWebhookSubscriptionRequest);
    expect(() =>
      createWebhook({
        eventTypes: ["run.completed", "run.failed"],
        name: "Run completion",
        resourceFilters: {
          aggregateTypes: ["run"],
          environmentIds: [id],
        },
        url: "https://example.test/hooks/runtime",
      }),
    ).not.toThrow();
    expect(() =>
      createWebhook({
        eventTypes: [],
        name: "No events",
        url: "https://example.test/hooks/runtime",
      }),
    ).toThrow();
    expect(() =>
      createWebhook({
        eventTypes: ["run.completed", "run.completed"],
        name: "Duplicates",
        url: "https://example.test/hooks/runtime",
      }),
    ).toThrow();
    expect(() =>
      createWebhook({
        eventTypes: ["run.completed"],
        name: "Empty filters",
        resourceFilters: {},
        url: "https://example.test/hooks/runtime",
      }),
    ).toThrow();
    expect(() =>
      createWebhook({
        eventTypes: ["run.completed"],
        name: "Duplicate filters",
        resourceFilters: { aggregateTypes: ["run", "run"] },
        url: "https://example.test/hooks/runtime",
      }),
    ).toThrow();
    expect(() =>
      createWebhook({
        eventTypes: ["run.completed"],
        name: "Too many filters",
        resourceFilters: {
          aggregateTypes: Array.from({ length: 101 }, (_, index) => `type-${index}`),
        },
        url: "https://example.test/hooks/runtime",
      }),
    ).toThrow();
    expect(() =>
      createWebhook({
        eventTypes: ["run.completed"],
        name: "Too many combined filters",
        resourceFilters: {
          aggregateIds: Array.from(
            { length: 51 },
            (_, index) => `01ARZ3NDEKTSV4RRFFQ69G5${String(index).padStart(3, "0")}`,
          ),
          aggregateTypes: Array.from({ length: 50 }, (_, index) => `type-${index}`),
        },
        url: "https://example.test/hooks/runtime",
      }),
    ).toThrow();
  });

  test("declares runtime discovery filters and vertical authorization scopes", () => {
    const route = (name: string) => RUNTIME_API_ROUTES.find((candidate) => candidate.name === name);
    const queryParameters = (name: string) => {
      const candidate = route(name);
      return candidate && "queryParameters" in candidate ? candidate.queryParameters : undefined;
    };
    expect(queryParameters("listRuns")).toContainEqual(
      expect.objectContaining({ name: "agentDeploymentId" }),
    );
    expect(queryParameters("listRuns")).toContainEqual(
      expect.objectContaining({ name: "executionBindingId" }),
    );
    expect(queryParameters("listThreads")).toContainEqual(
      expect.objectContaining({ name: "executionBindingId" }),
    );
    expect(queryParameters("listRuns")).toContainEqual(expect.objectContaining({ name: "status" }));
    expect(queryParameters("listApprovals")).toContainEqual(
      expect.objectContaining({ name: "status" }),
    );
    expect(route("getApproval")?.requiredAuthorization).toBe("approvals:read");
    expect(route("getCallbackDispatchEvidence")?.requiredAuthorization).toBe("approvals:read");
    expect(route("listRunToolCalls")?.requiredAuthorization).toBe("runs:read");
    expect(route("listWebhooks")?.requiredAuthorization).toBe("webhooks:read");
    expect(route("createWebhook")?.requiredAuthorization).toBe("webhooks:write");
    expect(route("createThread")?.idempotency).toBe("none");
    expect(route("createWebhook")?.idempotency).toBe("none");
  });

  test("matches automation request text and timezone limits", () => {
    const schedule = Schema.decodeUnknownSync(CreateScheduleRequest);
    const scheduleRequest = {
      agentDeploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      expression: "rate(1 hour)",
      name: "Hourly check",
      prompt: "Check production health",
      threadId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
    };
    expect(schedule({ ...scheduleRequest, timezone: "America/Phoenix" })).toMatchObject({
      threadId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
    });
    expect(() => schedule({ ...scheduleRequest, expression: "x".repeat(257) })).toThrow();
    expect(() => schedule({ ...scheduleRequest, name: "x".repeat(121) })).toThrow();
    expect(() => schedule({ ...scheduleRequest, prompt: "x".repeat(40_001) })).toThrow();
    expect(() => schedule({ ...scheduleRequest, timezone: "Not/A_Timezone" })).toThrow();
    expect(() => schedule({ ...scheduleRequest, timezone: "x".repeat(51) })).toThrow();

    const heartbeat = Schema.decodeUnknownSync(CreateHeartbeatRequest);
    const heartbeatRequest = {
      agentDeploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      instructions: "Review queued work",
      threadId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
    };
    expect(heartbeat({ ...heartbeatRequest, timezone: "UTC" })).toMatchObject({
      threadId: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
    });
    expect(() => heartbeat({ ...heartbeatRequest, instructions: "x".repeat(32_001) })).toThrow();
    expect(() => heartbeat({ ...heartbeatRequest, timezone: "Not/A_Timezone" })).toThrow();
  });

  test("uses the shared bounded cursor schema for runtime lists", () => {
    const decode = Schema.decodeUnknownSync(RuntimeListQuery);
    expect(() => decode({ cursor: "x".repeat(4_096) })).not.toThrow();
    expect(() => decode({ cursor: "" })).toThrow();
    expect(() => decode({ cursor: "x".repeat(4_097) })).toThrow();
  });

  test("bounds artifact access URL expiration to the signing policy", () => {
    const decode = Schema.decodeUnknownSync(CreateArtifactAccessUrlRequest);
    expect(() => decode({})).not.toThrow();
    expect(() => decode({ expiresInSeconds: 60 })).not.toThrow();
    expect(() => decode({ expiresInSeconds: 3600 })).not.toThrow();
    expect(() => decode({ expiresInSeconds: 59 })).toThrow();
    expect(() => decode({ expiresInSeconds: 3601 })).toThrow();
    expect(() => decode({ expiresInSeconds: 90.5 })).toThrow();
  });

  test("validates customer artifact upload and retention mutation bodies", () => {
    const decodeUpload = Schema.decodeUnknownSync(CreateArtifactUploadRequest);
    const upload = {
      byteSize: 12,
      contentType: "text/plain",
      fileName: "report.txt",
      name: "Release report",
      sha256: "a".repeat(64),
      type: "report",
    };
    expect(() => decodeUpload(upload)).not.toThrow();
    expect(() => decodeUpload({ ...upload, byteSize: 12.5 })).toThrow();
    expect(() => decodeUpload({ ...upload, fileName: "../report.txt" })).toThrow();
    expect(() => decodeUpload({ ...upload, fileName: "😀".repeat(100) })).toThrow();
    expect(() =>
      decodeUpload({ ...upload, metadata: { payload: "x".repeat(321 * 1024) } }),
    ).toThrow();
    expect(() => decodeUpload({ ...upload, sha256: "A".repeat(64) })).toThrow();
    expect(() => decodeUpload({ ...upload, visibility: "public" })).toThrow();

    for (const routeName of ["listArtifacts", "createArtifactUpload"]) {
      expect(RUNTIME_API_ROUTES.find((route) => route.name === routeName)?.errors).toContain(404);
    }

    const decodeRetention = Schema.decodeUnknownSync(UpdateArtifactRetentionRequest);
    expect(() =>
      decodeRetention({
        expectedVersion: 2,
        retentionExpiresAt: "2027-01-01T00:00:00.000Z",
      }),
    ).not.toThrow();
    expect(() => decodeRetention({ expectedVersion: 2, retentionExpiresAt: null })).not.toThrow();
    expect(() => decodeRetention({ expectedVersion: -1, retentionExpiresAt: null })).toThrow();
    expect(() => decodeRetention({ expectedVersion: 2 })).toThrow();
  });
});
