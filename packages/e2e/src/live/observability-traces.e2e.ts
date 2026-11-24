import { expect, it } from "@effect/vitest";
import { createPlatformSdk, PlatformApiError } from "@agentifiers/deployments-sdk";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { CliProcess, CliProcessLive } from "../harness/cli-process.ts";
import { eventually } from "../harness/eventually.ts";
import { acquireLiveAgent } from "../harness/live-agent.ts";
import { credentialedE2eEnabled, scopedE2eConfig } from "../harness/live-config.ts";
import { liveAgentModel } from "../harness/live-model.ts";

const enabled = credentialedE2eEnabled();

/** Trace facts reach ClickHouse through Kinesis and the hot-plane writer, so allow ingest lag. */
const TRACE_VISIBLE_TIMEOUT_MS = 10 * 60_000;

function promptOnlyManifest(runKey: string) {
  return {
    apiVersion: "agents.deployments.ai/v1",
    kind: "Agent",
    metadata: { key: runKey, name: `E2E observability ${runKey}`, version: "1.0.0" },
    spec: {
      instructions: "Reply with one short sentence. Never call tools.",
      model: liveAgentModel.model,
      runtime: liveAgentModel.runtime,
      sandbox: { mode: "none" },
      triggers: ["api"],
    },
  };
}

function call<T>(label: string, request: () => Promise<{ readonly data: T }>) {
  return Effect.tryPromise({
    try: async () => (await request()).data,
    catch: (cause) => new Error(`${label} failed.`, { cause }),
  });
}

it.effect.skipIf(!enabled)(
  "exposes a completed hosted run's trace, spans, and metrics through the public observability API",
  () =>
    Effect.gen(function* () {
      const config = yield* scopedE2eConfig;
      const cli = yield* CliProcess;
      const runKey = `e2e-traces-${randomUUID()}`;
      const agent = yield* acquireLiveAgent(cli, config, runKey, promptOnlyManifest(runKey), {
        serviceAccountScopes: ["observability:read"],
      });
      const context = {
        environmentId: config.environmentId,
        organizationId: config.organizationId,
        projectId: config.projectId,
      };
      const sdk = createPlatformSdk({ apiKey: agent.runtimeApiKey, baseUrl: config.apiUrl });
      const runtime = sdk.runtime(context);
      const observability = sdk.observability(context);

      const submitted = yield* call("run submit", () =>
        runtime.runs.submit(
          agent.deploymentId,
          { content: "Say hello to the observability check." },
          { idempotencyKey: `${runKey}:run` },
        ),
      );
      const runId = submitted.run.id;
      const threadId = submitted.run.threadId;

      const completed = yield* eventually(
        { intervalMs: 2_000, label: "run completion", timeoutMs: 5 * 60_000 },
        call("run read", () => runtime.runs.get(threadId, runId)).pipe(
          Effect.flatMap((run) => {
            if (run.status === "completed") return Effect.succeed(run);
            if (run.status === "failed" || run.status === "canceled") {
              return Effect.fail(new Error(`Run ${runId} ended as ${run.status}.`));
            }
            return Effect.succeed(undefined);
          }),
        ),
      );
      expect(completed.status).toBe("completed");

      const traceVisibleBy = Date.now() + TRACE_VISIBLE_TIMEOUT_MS;
      const trace = yield* eventually(
        { intervalMs: 5_000, label: "run trace visible", timeoutMs: TRACE_VISIBLE_TIMEOUT_MS },
        Effect.tryPromise({
          try: async () => (await observability.getRunTrace(runId)).data,
          catch: (cause) => cause,
        }).pipe(
          Effect.map((summary) => (summary.finalized_at ? summary : undefined)),
          Effect.catch((cause) =>
            cause instanceof PlatformApiError && cause.problem.status === 404
              ? Effect.succeed(undefined)
              : Effect.fail(new Error("Run trace read failed.", { cause })),
          ),
        ),
      );
      expect(trace.trace_id).toMatch(/^[0-9a-f]{32}$/u);
      expect(trace.root_run_id).toBe(runId);
      expect(trace.environment_id).toBe(config.environmentId);
      expect(trace.project_id).toBe(config.projectId);

      const spans = yield* eventually(
        {
          intervalMs: 5_000,
          label: "run and model spans visible",
          timeoutMs: Math.max(traceVisibleBy - Date.now(), 30_000),
        },
        call("trace spans", () =>
          observability.listTraceSpans(trace.trace_id, { limit: 100 }),
        ).pipe(
          Effect.map((page) =>
            page.items.some((span) => span.kind === "run") &&
            page.items.some((span) => span.kind === "model" && span.status === "ok")
              ? page
              : undefined,
          ),
        ),
      );
      expect(spans.items.every((span) => span.trace_id === trace.trace_id)).toBe(true);
      expect(spans.items.find((span) => span.kind === "run")).toMatchObject({
        name: "agent.run",
        run_id: runId,
        status: "ok",
      });
      const modelSpan = spans.items.find((span) => span.kind === "model" && span.status === "ok");
      expect(modelSpan).toMatchObject({
        name: "model.invocation",
        requested_model_id: liveAgentModel.model.id,
        run_id: runId,
      });
      expect(modelSpan?.input_tokens).toBeGreaterThan(0);
      expect(modelSpan?.output_tokens).toBeGreaterThan(0);

      const listed = yield* call("trace list", () => observability.listTraces({ limit: 100 }));
      expect(listed.items.some((item) => item.trace_id === trace.trace_id)).toBe(true);

      const modelGroup = modelSpan?.actual_model_id ?? liveAgentModel.model.id;
      const modelMetrics = yield* eventually(
        {
          intervalMs: 5_000,
          label: `model metrics group ${modelGroup} visible`,
          timeoutMs: Math.max(traceVisibleBy - Date.now(), 30_000),
        },
        call("model metrics", () => observability.metrics({ groupBy: "model" })).pipe(
          Effect.map((series) =>
            series.items.some((point) => point.group_value === modelGroup) ? series : undefined,
          ),
        ),
      );
      expect(modelMetrics).toMatchObject({ groupBy: "model", source: "model-invocations" });
      const modelPoint = modelMetrics.items.find((point) => point.group_value === modelGroup);
      expect(
        modelPoint && "invocation_count" in modelPoint ? modelPoint.invocation_count : 0,
      ).toBeGreaterThan(0);
    }).pipe(Effect.provide(CliProcessLive)),
  20 * 60_000,
);
