import { describe, expect, test } from "bun:test";
import {
  agentRunSubmissionRequest,
  artifactAccessExpiration,
  boundedStringValue,
  optionalBooleanValue,
  optionalObjectValue,
  runMessagePublicationRequest,
  runSearchRequest,
  runtimeListCursor,
  stringValue,
  threadCreationRequest,
  webhookSubscriptionRequest,
  workflowApprovalResolutionRequest,
  workflowExecutionCancelRequest,
  workflowExecutionStartRequest,
} from "./request-validation.ts";

describe("runtime API request validation", () => {
  test("strictly enforces the published agent run submission schema", () => {
    const publicId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    expect(
      agentRunSubmissionRequest({
        content: "Continue the workflow",
        runContext: "private workflow snapshot",
        threadId: publicId,
      }),
    ).toMatchObject({
      content: "Continue the workflow",
      runContext: "private workflow snapshot",
      threadId: publicId,
    });
    expect(() =>
      agentRunSubmissionRequest({ content: "Continue", runContext: " padded context " }),
    ).toThrow("Agent run submission request is invalid");
    expect(() => agentRunSubmissionRequest({ content: "Continue", unexpected: true })).toThrow(
      "Agent run submission request is invalid",
    );
  });

  test("accepts explicit structured private media input but rejects duplicate IDs and remote schema references", () => {
    const request = {
      content: "Analyze the input",
      threadId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      inputArtifacts: ["01ARZ3NDEKTSV4RRFFQ69G5FAW"],
      responseFormat: {
        type: "json_schema",
        name: "analysis",
        schema: {
          type: "object",
          properties: { summary: { type: "string" } },
          required: ["summary"],
        },
      },
    };
    expect(agentRunSubmissionRequest(request)).toMatchObject(request);
    expect(() =>
      agentRunSubmissionRequest({
        ...request,
        inputArtifacts: [...request.inputArtifacts, ...request.inputArtifacts],
      }),
    ).toThrow();
    expect(() =>
      agentRunSubmissionRequest({
        ...request,
        responseFormat: {
          ...request.responseFormat,
          schema: { $ref: "https://untrusted.invalid/schema" },
        },
      }),
    ).toThrow();
  });

  test("accepts only bounded delivered content for run message publication", () => {
    expect(runMessagePublicationRequest({ content: "Delivered" })).toEqual({
      content: "Delivered",
    });
    expect(() => runMessagePublicationRequest({ content: " padded " })).toThrow(
      "Run message publication request is invalid",
    );
    expect(() => runMessagePublicationRequest({ content: "Delivered", unexpected: true })).toThrow(
      "Run message publication request is invalid",
    );
    expect(() => runMessagePublicationRequest({ content: "x".repeat(256 * 1024 + 1) })).toThrow(
      "Run message publication request is invalid",
    );
  });

  test.each([[null], ["09:00-17:00"], [[]], [1], [true]])(
    "rejects malformed optional object value %p",
    (activeWindow) => {
      expect(() => optionalObjectValue({ activeWindow }, "activeWindow")).toThrow(
        "activeWindow must be an object",
      );
    },
  );

  test("accepts an object or omitted optional object value", () => {
    const activeWindow = { daysOfWeek: [1, 2, 3] };
    expect(optionalObjectValue({ activeWindow }, "activeWindow")).toBe(activeWindow);
    expect(optionalObjectValue({}, "activeWindow")).toBeUndefined();
  });

  test("bounds artifact access URL expiration", () => {
    expect(artifactAccessExpiration({})).toBe(900);
    expect(artifactAccessExpiration({ expiresInSeconds: 60 })).toBe(60);
    expect(artifactAccessExpiration({ expiresInSeconds: 3600 })).toBe(3600);
    for (const expiresInSeconds of [59, 3601, 90.5, "900"]) {
      expect(() => artifactAccessExpiration({ expiresInSeconds })).toThrow(
        "expiresInSeconds must be an integer between 60 and 3600",
      );
    }
  });

  test("caps artifact access at retention and rejects expired artifacts", () => {
    const now = new Date("2026-07-23T12:00:00.000Z");
    expect(
      artifactAccessExpiration(
        { expiresInSeconds: 900 },
        { now, retentionExpiresAt: "2026-07-23T12:01:30.000Z" },
      ),
    ).toBe(90);
    expect(() =>
      artifactAccessExpiration(
        { expiresInSeconds: 900 },
        { now, retentionExpiresAt: "2026-07-23T12:00:00.000Z" },
      ),
    ).toThrow("Artifact is not available");
  });

  test("rejects wrong-typed optional booleans", () => {
    expect(optionalBooleanValue({}, "skipWhenBusy")).toBeUndefined();
    expect(optionalBooleanValue({ skipWhenBusy: false }, "skipWhenBusy")).toBe(false);
    expect(() => optionalBooleanValue({ skipWhenBusy: "false" }, "skipWhenBusy")).toThrow(
      "skipWhenBusy must be a boolean",
    );
  });

  test("rejects wrong-typed optional strings", () => {
    expect(stringValue({}, "title", false)).toBeUndefined();
    expect(stringValue({ title: "  Runtime title  " }, "title", false)).toBe("Runtime title");
    for (const title of [null, false, 1, {}, []]) {
      expect(() => stringValue({ title }, "title", false)).toThrow("title is required");
    }
  });

  test("enforces declared trimmed-string request bounds", () => {
    expect(boundedStringValue({ content: "Done" }, "content", 4)).toBe("Done");
    expect(boundedStringValue({}, "content", 4, false)).toBeUndefined();
    expect(() => boundedStringValue({ content: " Done" }, "content", 10)).toThrow(
      "must be trimmed",
    );
    expect(() => boundedStringValue({ content: "12345" }, "content", 4)).toThrow(
      "1 to 4 characters",
    );
  });

  test("bounds public runtime list cursors before decoding", () => {
    expect(runtimeListCursor("x".repeat(4_096))).toHaveLength(4_096);
    expect(() => runtimeListCursor("")).toThrow("from 1 to 4096 characters");
    expect(() => runtimeListCursor("x".repeat(4_097))).toThrow("from 1 to 4096 characters");
  });

  test("strictly enforces the public run-search request schema", () => {
    const agentDeploymentId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    expect(
      runSearchRequest({
        agentDeploymentId,
        createdAfter: "2026-07-25T00:00:00.000Z",
        limit: 25,
        status: "running",
      }),
    ).toMatchObject({
      agentDeploymentId,
      createdAfter: "2026-07-25T00:00:00.000Z",
      limit: 25,
      status: "running",
    });
    expect(() =>
      runSearchRequest({
        agentDeploymentId,
        createdAfer: "2026-07-25T00:00:00.000Z",
      }),
    ).toThrow("Run search request is invalid");
  });

  test("enforces the public webhook subscription request schema", () => {
    expect(
      webhookSubscriptionRequest({
        eventTypes: ["run.completed", "run.failed"],
        name: "Runtime completion",
        resourceFilters: { aggregateTypes: ["run"] },
        url: "https://example.test/hooks/runtime",
      }),
    ).toEqual({
      eventTypes: ["run.completed", "run.failed"],
      name: "Runtime completion",
      resourceFilters: { aggregateTypes: ["run"] },
      url: "https://example.test/hooks/runtime",
    });
    for (const request of [
      {
        eventTypes: ["run.completed", "run.completed"],
        name: "Duplicate events",
        url: "https://example.test/hooks/runtime",
      },
      {
        eventTypes: Array.from({ length: 101 }, (_, index) => `event.${index}`),
        name: "Too many events",
        url: "https://example.test/hooks/runtime",
      },
      {
        eventTypes: ["x".repeat(129)],
        name: "Long event",
        url: "https://example.test/hooks/runtime",
      },
      {
        eventTypes: ["run.completed"],
        name: "x".repeat(121),
        url: "https://example.test/hooks/runtime",
      },
      {
        eventTypes: ["run.completed"],
        name: "Long URL",
        url: `https://example.test/${"x".repeat(2_100)}`,
      },
      {
        eventTypes: ["run.completed"],
        name: "Duplicate filters",
        resourceFilters: { aggregateTypes: ["run", "run"] },
        url: "https://example.test/hooks/runtime",
      },
      {
        eventTypes: ["run.completed"],
        name: "Too many filters",
        resourceFilters: {
          aggregateTypes: Array.from({ length: 101 }, (_, index) => `type-${index}`),
        },
        url: "https://example.test/hooks/runtime",
      },
    ]) {
      expect(() => webhookSubscriptionRequest(request)).toThrow(
        "Webhook subscription request is invalid",
      );
    }
  });

  test("enforces the public independent-thread request schema", () => {
    const agentDeploymentId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const request = threadCreationRequest({
      agentDeploymentId,
      continueFromThreadId: agentDeploymentId,
      title: "Release follow-up",
      workspaceId: agentDeploymentId,
    });
    expect(String(request.agentDeploymentId)).toBe(agentDeploymentId);
    expect(String(request.continueFromThreadId)).toBe(agentDeploymentId);
    expect(request.title).toBe("Release follow-up");
    expect(String(request.workspaceId)).toBe(agentDeploymentId);
    expect(() => threadCreationRequest({ agentDeploymentId, title: "x".repeat(121) })).toThrow(
      "Thread creation request is invalid",
    );
  });

  test("strictly validates workflow execution and approval mutation requests", () => {
    const workspaceId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const start = workflowExecutionStartRequest({ input: { release: "1.2.3" }, workspaceId });
    expect(start.input).toEqual({ release: "1.2.3" });
    expect(String(start.workspaceId)).toBe(workspaceId);
    expect(workflowExecutionCancelRequest({ expectedVersion: 2 })).toEqual({
      expectedVersion: 2,
    });
    expect(workflowApprovalResolutionRequest({ decision: "approved" })).toEqual({
      decision: "approved",
    });
    for (const invalid of [
      () => workflowExecutionStartRequest({ unexpected: true }),
      () => workflowExecutionCancelRequest({ expectedVersion: "2" }),
      () => workflowApprovalResolutionRequest({ decision: "maybe" }),
    ]) {
      expect(invalid).toThrow("invalid");
      try {
        invalid();
      } catch (cause) {
        expect(cause).toMatchObject({ code: "invalid_request", status: 400 });
      }
    }
  });
});
