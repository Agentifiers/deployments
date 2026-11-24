import type { ModelGatewayService } from "@deployments-ai/model-gateway";
import {
  JudgeModelTimeoutError,
  type JudgeModelPort,
} from "@deployments-ai/observability/evaluators";
import { Effect, Predicate } from "effect";
import type { EvaluationJudgeContext, EvaluationJudgeTenant } from "./evaluation-ports.ts";

const JUDGE_RESPONSE_FORMAT_NAME = "evaluation_judgment";

/**
 * Judge model access through the model gateway. Calls never create runs, traces, or customer meter
 * events: usage is computed against the evaluated run's id with an `evaluation-judge:` model call
 * id, returned to the caller, and recorded on the score result as internal evaluator usage. The
 * gateway is loaded for the evaluated environment, whose policy and grants admit the judge model.
 */
export function makeGatewayJudgePort(
  loadGateway: (
    tenant: EvaluationJudgeTenant,
  ) => Promise<Pick<ModelGatewayService, "chatCompletion">>,
  context: EvaluationJudgeContext,
): JudgeModelPort {
  return {
    async complete(request) {
      const gateway = await loadGateway({
        environmentId: context.environmentId,
        organizationId: context.organizationId,
        projectId: context.projectId,
      });
      const signal = AbortSignal.timeout(request.timeoutMs);
      try {
        const result = await Effect.runPromise(
          gateway.chatCompletion({
            maxTokens: request.maxOutputTokens,
            messages: [
              { content: request.system, role: "system" },
              { content: request.user, role: "user" },
            ],
            modelCallId: `evaluation-judge:${context.traceId}:${context.scoreDefinitionId}:${context.revision}`,
            modelId: request.modelId,
            responseFormat: {
              name: JUDGE_RESPONSE_FORMAT_NAME,
              schema: request.responseSchema,
              type: "json_schema",
            },
            runId: context.runId,
            signal,
          }),
        );
        const costUsdMicros = result.usage?.costUsdMicros;
        return {
          text: result.assistantMessage ?? "",
          ...(result.modelId ? { modelId: result.modelId } : {}),
          ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
          ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
          ...(costUsdMicros !== undefined ? { costUsdMicros: Math.round(costUsdMicros) } : {}),
        };
      } catch (cause) {
        if (signal.aborted) {
          throw new JudgeModelTimeoutError(
            `Judge model did not respond within ${request.timeoutMs}ms.`,
          );
        }
        // The scorer records only judge_unavailable, so the cause is logged here.
        console.error("Evaluation judge model request failed.", {
          error: cause instanceof Error ? cause.message : String(cause),
          errorTag: Predicate.hasProperty(cause, "_tag") ? String(cause._tag) : undefined,
          modelId: request.modelId,
          scoreDefinitionId: context.scoreDefinitionId,
          traceId: context.traceId,
        });
        throw cause;
      }
    },
  };
}
