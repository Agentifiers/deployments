import { describe, expect, test } from "bun:test";
import { createTestAgentRuntime, id, input } from "./runtime.fixture.ts";
import { modelGatewayGenerationPort } from "./model-gateway.ts";
import { makeModelGateway, type ModelGatewayService } from "@deployments-ai/model-gateway";
import type { AgentResponseFormat } from "@deployments-ai/agent-manifest";
import type { RuntimeModelGenerationRequest } from "./types.ts";
import type { RuntimeModelInvocationAttempt } from "./model-generation-types.ts";
import { runtimeExecutionFailureState } from "./errors.ts";

const responseFormat: AgentResponseFormat = {
  type: "json_schema",
  name: "summary",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["answer"],
    properties: { answer: { type: "string" } },
  },
};

describe("explicit final response contracts", () => {
  test("retries malformed final JSON, retains charges and bypasses ordinary response-depth classification", async () => {
    const attempts: RuntimeModelInvocationAttempt[] = [];
    const requests: RuntimeModelGenerationRequest[] = [];
    const runtime = createTestAgentRuntime({
      recordModelInvocation: async (attempt) => {
        attempts.push(attempt);
      },
      generateAssistantMessage: async (request) => {
        requests.push(request);
        return {
          assistantMessage:
            requests.length === 1 ? '{"private_invalid_draft":true}' : '{"answer":"ok"}',
          usage: [
            {
              idempotencyKey: request.modelCallId,
              occurredAt: 1,
              quantity: 10,
              source: "model-gateway",
              type: "model_tokens",
              unit: "tokens",
            },
          ],
        };
      },
    });
    const result = await runtime.execute(
      input({
        responseFormat,
        modelFallbackIds: [],
        responseDepthPolicy: {
          classifierInstructions: "Select a response depth.",
          detailedInstructions: "Explain in detail.",
          minimumWords: 8,
          maximumWords: 16,
        },
      }),
    );
    expect(result.assistantMessage).toBe('{"answer":"ok"}');
    expect(requests.map((request) => request.responseDepthPolicy)).toEqual([undefined, undefined]);
    expect(attempts.map((attempt) => attempt.status)).toEqual(["failed", "succeeded"]);
    expect(
      result.usage.filter((entry) => entry.type === "model_tokens").map((entry) => entry.quantity),
    ).toEqual([10, 10]);
    expect(JSON.stringify({ result, attempts })).not.toContain("private_invalid_draft");
  });

  test("fails instead of publishing a schema-invalid response after bounded recovery", async () => {
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: async () => ({ assistantMessage: "not-json-private" }),
    });
    const failure = await runtime
      .execute(input({ responseFormat, modelFallbackIds: [] }))
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(Error);
    expect(JSON.stringify(runtimeExecutionFailureState(failure))).not.toContain("not-json-private");
  });

  test("does not validate intermediate tool text as final JSON and reauthorizes media after the tool", async () => {
    let generations = 0;
    let artifactLoads = 0;
    let toolCalls = 0;
    const runtime = createTestAgentRuntime({
      authorizeToolCall: async () => ({
        action: "allow",
        reason: "Allowed read.",
        toolCallId: id("20"),
      }),
      executeToolCall: async () => {
        toolCalls += 1;
        return { status: "completed", outputSummary: "read result" };
      },
      loadInputArtifacts: async ({ media, threadId }) => {
        artifactLoads += 1;
        return media.artifactIds.map((artifactId) => ({
          artifactId,
          messageId: media.promptMessageId,
          threadId,
          content: Uint8Array.from([0xff, 0xd8, 0xff]),
          contentType: "image/jpeg",
          kind: "image",
        }));
      },
      generateAssistantMessage: async () =>
        ++generations === 1
          ? {
              assistantMessage: "Checking the resource first.",
              toolCalls: [
                {
                  toolName: "provider.read",
                  modelToolCallId: "read-1",
                  input: { resource: "account" },
                },
              ],
            }
          : { assistantMessage: '{"answer":"read complete"}' },
    });
    const result = await runtime.execute(
      input({
        responseFormat,
        modelToolNames: ["provider.read"],
        inputMedia: {
          artifactIds: [id("10")],
          owner: { serviceAccountId: id("12"), type: "service-account" },
          promptMessageId: id("13"),
        },
      }),
    );
    expect(result.assistantMessage).toBe('{"answer":"read complete"}');
    expect(toolCalls).toBe(1);
    expect(artifactLoads).toBe(2);
  });

  test("sends current private image and audio bytes in the actual provider body without replaying historical media", async () => {
    const bodies: Record<string, unknown>[] = [];
    const gateway = makeModelGateway({
      baseUrl: "https://gateway.invalid",
      credentials: async () => "test-token",
    });
    const scopedGateway: ModelGatewayService = {
      ...gateway,
      chatCompletion: (request) =>
        gateway.chatCompletion({
          ...request,
          fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
            const body = init?.body;
            if (typeof body !== "string") throw new Error("Expected a JSON string request body.");
            bodies.push(JSON.parse(body) as Record<string, unknown>);
            return Response.json({
              id: "response-1",
              model: "openai/gpt-4o",
              choices: [
                {
                  finish_reason: "stop",
                  message: { content: '{"answer":"red frame and speech"}' },
                },
              ],
              usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
            });
          }) as typeof fetch,
        }),
    };
    const image = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const audio = new TextEncoder().encode("RIFF0000WAVEfmt private audio");
    const runtime = createTestAgentRuntime({
      generateAssistantMessage: modelGatewayGenerationPort(scopedGateway),
      loadInputArtifacts: async ({ media, threadId }) =>
        media.artifactIds.map((artifactId, index) => {
          const scope = { artifactId, messageId: media.promptMessageId, threadId };
          return index === 0
            ? { ...scope, content: image, contentType: "image/jpeg", kind: "image" }
            : { ...scope, content: audio, contentType: "audio/wav", kind: "audio" };
        }),
    });
    const result = await runtime.execute(
      input({
        responseFormat,
        modelId: "openai/gpt-4o",
        modelFallbackIds: [],
        modelInputTokenBudget: 100_000,
        modelOutputTokenReserve: 1024,
        inputMedia: {
          artifactIds: [id("10"), id("11")],
          owner: { serviceAccountId: id("12"), type: "service-account" },
          promptMessageId: id("13"),
        },
        recentMessages: [
          {
            content: "An earlier attachment",
            role: "user",
            messageId: id("14"),
            threadId: id("15"),
            inputArtifacts: [id("16")],
          },
        ],
      }),
    );
    expect(result.assistantMessage).toBe('{"answer":"red frame and speech"}');
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "summary", schema: responseFormat.schema, strict: false },
    });
    const serialized = JSON.stringify(bodies[0]?.messages);
    expect(serialized).toContain(`data:image/jpeg;base64,${Buffer.from(image).toString("base64")}`);
    expect(serialized).toContain(Buffer.from(audio).toString("base64"));
    expect(serialized).toContain('"type":"input_audio"');
    expect(serialized).not.toContain(id("16"));
    expect(serialized).not.toContain("binary omitted");
  });
});
