import { describe, expect, test } from "bun:test";
import { createTestAgentRuntime, id, input } from "./runtime.fixture.ts";
import { RuntimeToolExecutionKnownFailureError } from "./errors.ts";

describe("model-native tool loop", () => {
  test("regenerates transient artifacts for resumed completed tools", async () => {
    const request = {
      effect: "read" as const,
      idempotencyKey: "completed-access",
      input: { resource: "artifact-30" },
      inputSummary: "Inspect artifact",
      requiredScopes: [],
      toolName: "provider.read",
    };
    let executions = 0;
    let observedArtifacts: readonly unknown[] = [];
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => {
        throw new Error("Completed tools must not be reauthorized during transient refresh.");
      },
      executeToolCall: async () => {
        executions += 1;
        return {
          status: "completed",
          transientArtifacts: [
            {
              content: '{"url":"https://temporary.example/refreshed"}',
              fileName: "access.json",
              label: "Refreshed access",
            },
          ],
        };
      },
      generateAssistantMessage: async (generation) => {
        observedArtifacts = generation.sandboxArtifacts;
        return { assistantMessage: "Refreshed access is available." };
      },
    });

    await runtime.execute(
      input({
        completedToolCalls: [
          {
            ...request,
            policyAction: "allow",
            policyReason: "Previously allowed.",
            refreshTransientArtifacts: true,
            toolCallId: id("20"),
          },
        ],
        toolRequests: [request],
      }),
    );

    expect(executions).toBe(1);
    expect(observedArtifacts).toEqual([
      expect.objectContaining({ content: expect.stringContaining("temporary.example/refreshed") }),
    ]);
  });

  test("omits transient access superseded by a later completed archive", async () => {
    let executions = 0;
    let observedArtifacts: readonly unknown[] = [];
    const inspectRequest = {
      effect: "read" as const,
      idempotencyKey: "inspect-artifact",
      input: { artifactId: id("30") },
      inputSummary: "Inspect artifact",
      toolName: "artifact.inspect",
    };
    const archiveRequest = {
      ...inspectRequest,
      effect: "write" as const,
      idempotencyKey: "archive-artifact",
      inputSummary: "Archive artifact",
      toolName: "artifact.archive",
    };
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => {
        throw new Error("superseded access must not be reauthorized");
      },
      executeToolCall: async () => {
        executions += 1;
        throw new Error("superseded access must not refresh");
      },
      generateAssistantMessage: async (generation) => {
        observedArtifacts = generation.sandboxArtifacts;
        return { assistantMessage: "The artifact was archived." };
      },
      resolveToolDefinition: async (toolName) => ({
        description: toolName,
        effect: toolName === "artifact.archive" ? "write" : "read",
        inputSchema: {
          additionalProperties: false,
          properties: { artifactId: { type: "string" } },
          required: ["artifactId"],
          type: "object",
        },
        requiredScopes: [],
        toolName,
      }),
    });

    await runtime.execute(
      input({
        completedToolCalls: [
          {
            ...inspectRequest,
            policyAction: "allow",
            policyReason: "Allowed.",
            refreshTransientArtifacts: true,
            requiredScopes: [],
            toolCallId: id("20"),
          },
          {
            ...archiveRequest,
            policyAction: "allow",
            policyReason: "Allowed.",
            requiredScopes: [],
            toolCallId: id("21"),
          },
        ],
        toolRequests: [inspectRequest, archiveRequest],
      }),
    );

    expect(executions).toBe(0);
    expect(observedArtifacts).toEqual([]);
  });

  test("omits transient access that has permanently expired before resume", async () => {
    let observedArtifacts: readonly unknown[] = [];
    const inspectRequest = {
      effect: "read" as const,
      idempotencyKey: "inspect-expired-artifact",
      input: { artifactId: id("30") },
      inputSummary: "Inspect artifact",
      toolName: "artifact.inspect",
    };
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => {
        throw new Error("completed access must not be reauthorized");
      },
      executeToolCall: async () => {
        throw new RuntimeToolExecutionKnownFailureError(
          "artifact.inspect",
          new TypeError("Artifact retention has expired."),
        );
      },
      generateAssistantMessage: async (generation) => {
        observedArtifacts = generation.sandboxArtifacts;
        return { assistantMessage: "The old access URL expired." };
      },
      resolveToolDefinition: async (toolName) => ({
        description: "Inspect artifact",
        effect: "read",
        inputSchema: {
          additionalProperties: false,
          properties: { artifactId: { type: "string" } },
          required: ["artifactId"],
          type: "object",
        },
        requiredScopes: [],
        toolName,
      }),
    });

    await runtime.execute(
      input({
        completedToolCalls: [
          {
            ...inspectRequest,
            policyAction: "allow",
            policyReason: "Allowed.",
            refreshTransientArtifacts: true,
            requiredScopes: [],
            toolCallId: id("20"),
          },
        ],
        toolRequests: [inspectRequest],
      }),
    );

    expect(observedArtifacts).toEqual([]);
  });

  test("prunes same-run transient access when a later tool archives the artifact", async () => {
    const toolRequests = [
      {
        effect: "read" as const,
        idempotencyKey: "inspect-current-artifact",
        input: { artifactId: id("30") },
        inputSummary: "Inspect artifact",
        toolName: "artifact.inspect",
      },
      {
        effect: "write" as const,
        idempotencyKey: "archive-current-artifact",
        input: { artifactId: id("30") },
        inputSummary: "Archive artifact",
        toolName: "artifact.archive",
      },
    ];
    let authorizations = 0;
    let observedArtifacts: readonly unknown[] = [];
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => ({
        action: "allow",
        reason: "Allowed.",
        toolCallId: id(String(20 + authorizations++)),
      }),
      executeToolCall: async (request) =>
        request.toolName === "artifact.inspect"
          ? {
              status: "completed",
              transientArtifacts: [
                {
                  content: '{"url":"https://temporary.example/access"}',
                  fileName: "access.json",
                  label: "Artifact access",
                  metadata: { artifactId: id("30"), kind: "artifact-access" },
                },
              ],
            }
          : { status: "completed" },
      generateAssistantMessage: async (generation) => {
        observedArtifacts = generation.sandboxArtifacts;
        return { assistantMessage: "The artifact was archived." };
      },
      resolveToolDefinition: async (toolName) => ({
        description: toolName,
        effect: toolName === "artifact.archive" ? "write" : "read",
        inputSchema: {
          additionalProperties: false,
          properties: { artifactId: { type: "string" } },
          required: ["artifactId"],
          type: "object",
        },
        requiredScopes: [],
        toolName,
      }),
    });

    await runtime.execute(input({ toolRequests }));

    expect(observedArtifacts).toEqual([]);
  });
});
