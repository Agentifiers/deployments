import { describe, expect, jest, test } from "bun:test";
import {
  CURATED_MODEL_IDS,
  makeModelGateway,
  modelGatewayServiceCredentials,
  type ModelGatewayChatCompletionRequest,
  type ModelGatewayChatCompletionResult,
  type ModelGatewayService,
  type ModelTokenRequest,
} from "@deployments-ai/model-gateway";
import {
  DEFAULT_JUDGE_TIMEOUT_MS,
  JUDGE_RESPONSE_SCHEMA,
  JudgeModelTimeoutError,
  type JudgeModelRequest,
} from "@deployments-ai/observability/evaluators";
import { Effect } from "effect";
import { makeGatewayJudgePort } from "./evaluation-judge.ts";
import { scoreRun } from "./evaluation-scoring.ts";
import { evaluationHarness } from "./evaluation-worker.fixture.ts";

const CURATED_JUDGE_MODEL_ID = CURATED_MODEL_IDS[0]!;

const request: JudgeModelRequest = {
  internalEvaluator: true,
  maxOutputTokens: 256,
  modelId: "openrouter/judge",
  responseSchema: JUDGE_RESPONSE_SCHEMA,
  system: "Grade it.",
  timeoutMs: DEFAULT_JUDGE_TIMEOUT_MS,
  user: "Response: hi",
};
const context = {
  environmentId: "01K00000000000000000000ENV",
  organizationId: "01K00000000000000000000ORG",
  projectId: "01K00000000000000000000PRJ",
  revision: 2,
  runId: "01M44TC0D0ZE3J6DZK6S1NGW3F",
  scoreDefinitionId: "01K00000000000000000000DEF",
  traceId: "f".repeat(32),
};

function gateway(
  respond: (
    request: ModelGatewayChatCompletionRequest,
  ) => Promise<ModelGatewayChatCompletionResult>,
): Pick<ModelGatewayService, "chatCompletion"> {
  return { chatCompletion: (input) => Effect.promise(() => respond(input)) };
}

describe("gateway judge port", () => {
  test("gets a JSON-schema judgment and its usage through the model gateway client", async () => {
    const bodies: unknown[] = [];
    const server = Bun.serve({
      fetch: async (incoming) => {
        bodies.push(await incoming.json());
        return Response.json({
          choices: [
            {
              finish_reason: "stop",
              index: 0,
              message: { content: '{"value":0.8,"rationale":"close"}', role: "assistant" },
            },
          ],
          id: "chatcmpl-judge",
          model: "openrouter/judge-v2",
          usage: { completion_tokens: 12, cost: 0.0000374, prompt_tokens: 120, total_tokens: 132 },
        });
      },
      port: 0,
    });
    const issued: ModelTokenRequest[] = [];
    const tenants: unknown[] = [];
    const port = makeGatewayJudgePort(async (tenant) => {
      tenants.push(tenant);
      return makeModelGateway({
        baseUrl: server.url.href,
        credentials: modelGatewayServiceCredentials({
          context: () => tenant,
          issue: async (tokenRequest) => {
            issued.push(tokenRequest);
            return {
              expiresAt: Date.now() / 1_000 + 600,
              models: ["openrouter/judge"],
              token: "t",
            };
          },
        }),
      });
    }, context);

    try {
      const response = await port.complete(request);

      expect(response).toEqual({
        costUsdMicros: 37,
        inputTokens: 120,
        modelId: "openrouter/judge-v2",
        outputTokens: 12,
        text: '{"value":0.8,"rationale":"close"}',
      });
    } finally {
      await server.stop(true);
    }
    // The judge token is minted for the evaluated environment, whose policy admits the model.
    const tenant = {
      environmentId: context.environmentId,
      organizationId: context.organizationId,
      projectId: context.projectId,
    };
    expect(tenants).toEqual([tenant]);
    expect(issued).toEqual([
      { context: tenant, kind: "service", models: expect.arrayContaining(["openrouter/judge"]) },
    ]);
    expect(bodies[0]).toMatchObject({
      max_tokens: 256,
      messages: [
        { content: "Grade it.", role: "system" },
        { content: "Response: hi", role: "user" },
      ],
      model: "openrouter/judge",
      response_format: {
        json_schema: { name: "evaluation_judgment", schema: JUDGE_RESPONSE_SCHEMA },
        type: "json_schema",
      },
    });
  });

  test("raises a judge timeout once the request budget elapses without an answer", async () => {
    const received = Promise.withResolvers<AbortSignal | undefined>();
    const port = makeGatewayJudgePort(async () => {
      // Faking time only once the port loads the gateway keeps a port that never gets that far
      // on real timers, where Bun's per-test timeout still fires.
      jest.useFakeTimers();
      return gateway((input) => {
        const { promise, reject } = Promise.withResolvers<ModelGatewayChatCompletionResult>();
        input.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        received.resolve(input.signal);
        return promise;
      });
    }, context);

    const completion = port.complete(request);
    try {
      const signal = await Promise.race([
        received.promise,
        completion.then(() => {
          throw new Error("The judge completed without calling the gateway.");
        }),
      ]);

      jest.advanceTimersByTime(request.timeoutMs - 1);
      expect(signal?.aborted).toBe(false);
      jest.advanceTimersByTime(1);
      expect(signal?.aborted).toBe(true);
    } finally {
      jest.useRealTimers();
    }

    expect(completion).rejects.toBeInstanceOf(JudgeModelTimeoutError);
  }, 15_000);
});

describe("model judge scoring", () => {
  test("stores invalid judge output as an error result with internal evaluator usage", async () => {
    const harness = evaluationHarness();
    const definition = await harness.seedDefinition({
      kind: "model_judge",
      modelId: CURATED_JUDGE_MODEL_ID,
      prompt: "Grade {{output}} for {{input}}",
    });
    const seeded = harness.seedRun({
      content: "Where is my refund?",
      run: { outputText: "It is coming.", status: "completed" },
    });
    harness.setJudgeResponse({
      inputTokens: 50,
      modelId: CURATED_JUDGE_MODEL_ID,
      outputTokens: 4,
      text: "great job",
    });
    const run = await harness.persistence.getRun(seeded.threadId, seeded.runId);

    const outcome = await scoreRun(harness.context, {
      definitions: [{ revision: 1, scoreDefinitionId: definition.data.scoreDefinitionId }],
      expectations: {},
      run: run!,
      source: "automatic",
    });

    expect(harness.judgeRequests[0]?.user).toBe("Grade It is coming. for Where is my refund?");
    expect(outcome.scores).toEqual([
      {
        errorClass: "judge_invalid_output",
        executionStatus: "error",
        revision: 1,
        scoreDefinitionId: definition.data.scoreDefinitionId,
      },
    ]);
    const [result] = (await harness.persistence.listTraceScoreResults(seeded.traceId, {})).items;
    expect(result?.data).toMatchObject({
      errorClass: "judge_invalid_output",
      executionStatus: "error",
      judge: {
        inputTokens: 50,
        internalEvaluator: true,
        modelId: CURATED_JUDGE_MODEL_ID,
        outputTokens: 4,
      },
      scoreType: "model-judged",
    });
    expect(result?.data.value).toBeUndefined();
  });

  test("records invalid_configuration without calling a judge model the policy denies", async () => {
    const harness = evaluationHarness();
    const definition = await harness.seedDefinition({
      kind: "model_judge",
      modelId: "openrouter/vendor/frontier-model",
      prompt: "Grade {{output}}",
    });
    const seeded = harness.seedRun({
      content: "Where is my refund?",
      run: { outputText: "It is coming.", status: "completed" },
    });
    const run = await harness.persistence.getRun(seeded.threadId, seeded.runId);

    const outcome = await scoreRun(harness.context, {
      definitions: [{ revision: 1, scoreDefinitionId: definition.data.scoreDefinitionId }],
      expectations: {},
      run: run!,
      source: "automatic",
    });

    expect(harness.judgeRequests).toEqual([]);
    expect(outcome.scores).toEqual([
      {
        errorClass: "invalid_configuration",
        executionStatus: "error",
        revision: 1,
        scoreDefinitionId: definition.data.scoreDefinitionId,
      },
    ]);
    const [result] = (await harness.persistence.listTraceScoreResults(seeded.traceId, {})).items;
    expect(result?.data.errorMessage).toContain("model_not_allowed_by_environment_policy");
  });
});
