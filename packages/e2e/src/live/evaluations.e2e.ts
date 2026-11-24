import { expect, it } from "@effect/vitest";
import { PublicId } from "@deployments-ai/api-contract/primitives";
import { createPlatformSdk, type EvaluationsSdk } from "@agentifiers/deployments-sdk";
import { randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";
import { CliProcess, CliProcessLive } from "../harness/cli-process.ts";
import { acquireLiveAgent } from "../harness/live-agent.ts";
import { credentialedE2eEnabled, scopedE2eConfig } from "../harness/live-config.ts";
import { liveAgentModel } from "../harness/live-model.ts";

const enabled = credentialedE2eEnabled();
const publicId = Schema.decodeUnknownSync(PublicId);

const EVALUATION_SCOPES = ["observability:read", "observability:write"] as const;
const WAIT_TIMEOUT_MS = 15 * 60_000;
const PASS_PHRASE = "GREEN-LIGHT";
const FORBIDDEN_PHRASE = "RED-LIGHT";

function call<T>(label: string, request: () => Promise<{ readonly data: T }>) {
  return Effect.tryPromise({
    try: async () => (await request()).data,
    catch: (cause) => new Error(`${label} failed.`, { cause }),
  });
}

function promptOnlyManifest(runKey: string, role: "baseline" | "candidate") {
  return {
    apiVersion: "agents.deployments.ai/v1",
    kind: "Agent",
    metadata: { key: runKey, name: `E2E evaluation ${role} ${runKey}`, version: "1.0.0" },
    spec: {
      instructions:
        role === "baseline"
          ? `Whatever the user asks, reply with exactly one sentence: "Status: ${PASS_PHRASE} confirmed." Never call tools.`
          : `Whatever the user asks, reply with exactly one short sentence that includes the phrase "Status: ${PASS_PHRASE} confirmed." Never call tools.`,
      model: liveAgentModel.model,
      runtime: liveAgentModel.runtime,
      sandbox: { mode: "none" },
      triggers: ["api"],
    },
  };
}

function archiveOnRelease(label: string, archive: () => Promise<unknown>) {
  return Effect.tryPromise({
    try: archive,
    catch: (cause) => new Error(`${label} cleanup failed.`, { cause }),
  }).pipe(
    Effect.catch((error) => Effect.logWarning(error.message, error.cause)),
    Effect.asVoid,
  );
}

function scoreDefinition(
  evaluations: EvaluationsSdk,
  runKey: string,
  name: string,
  evaluator: Parameters<EvaluationsSdk["createScoreDefinition"]>[0]["evaluator"],
) {
  return Effect.acquireRelease(
    call("score definition create", () =>
      evaluations.createScoreDefinition(
        { evaluator, name: `${name}-${runKey}` },
        { idempotencyKey: `${runKey}:definition:${name}` },
      ),
    ),
    (created) =>
      archiveOnRelease("score definition", () =>
        evaluations.archiveScoreDefinition(created.id, {
          idempotencyKey: `${runKey}:definition:${name}:archive`,
        }),
      ),
  );
}

it.effect.skipIf(!enabled)(
  "proves score definitions, dataset import, a release evaluation run, and an advisory release comparison",
  () =>
    Effect.gen(function* () {
      const config = yield* scopedE2eConfig;
      const cli = yield* CliProcess;
      const runKey = `e2e-eval-${randomUUID()}`;
      const agentOptions = { serviceAccountScopes: EVALUATION_SCOPES };
      const baseline = yield* acquireLiveAgent(
        cli,
        config,
        `${runKey}-base`,
        promptOnlyManifest(`${runKey}-base`, "baseline"),
        agentOptions,
      );
      const candidate = yield* acquireLiveAgent(
        cli,
        config,
        `${runKey}-cand`,
        promptOnlyManifest(`${runKey}-cand`, "candidate"),
        agentOptions,
      );
      const evaluations = createPlatformSdk({
        apiKey: baseline.runtimeApiKey,
        baseUrl: config.apiUrl,
      }).evaluations({
        environmentId: config.environmentId,
        organizationId: config.organizationId,
        projectId: config.projectId,
      });

      // The judge runs on the live agent model, so a deployment that relays that model must also
      // admit and route it for evaluation judges.
      const judge = yield* scoreDefinition(evaluations, runKey, "judge", {
        kind: "model_judge",
        modelId: liveAgentModel.model.id,
        prompt: `Score 1 when the response includes "${PASS_PHRASE}", otherwise 0.\nResponse: {{output}}`,
      });
      const definitions = [
        yield* scoreDefinition(evaluations, runKey, "includes", { kind: "contains" }),
        yield* scoreDefinition(evaluations, runKey, "excludes", { kind: "not_contains" }),
        yield* scoreDefinition(evaluations, runKey, "no-tools", { kind: "no_tool" }),
        judge,
      ];
      const scoreDefinitionIds = definitions.map((definition) => definition.id);
      for (const definition of definitions) {
        expect(definition.status).toBe("active");
        expect(definition.currentRevision).toBe(1);
      }

      const dataset = yield* Effect.acquireRelease(
        call("dataset create", () =>
          evaluations.createRegressionDataset(
            { name: `dataset-${runKey}`, retentionDays: 1 },
            { idempotencyKey: `${runKey}:dataset` },
          ),
        ),
        (created) =>
          archiveOnRelease("dataset", () =>
            evaluations.archiveRegressionDataset(created.id, {
              idempotencyKey: `${runKey}:dataset:archive`,
            }),
          ),
      );
      const imported = yield* call("dataset case import", () =>
        evaluations.importDatasetCases(
          dataset.id,
          {
            cases: [
              {
                expected: { mustInclude: [PASS_PHRASE], mustNot: [FORBIDDEN_PHRASE] },
                id: "status-check",
                message: "What is the current status?",
                tags: ["e2e"],
              },
              {
                expected: { mustInclude: [PASS_PHRASE], mustNot: [FORBIDDEN_PHRASE] },
                id: "greeting",
                message: "Hello there, how are you today?",
                tags: ["e2e"],
              },
            ],
          },
          { idempotencyKey: `${runKey}:dataset:import` },
        ),
      );
      expect(imported.created).toBe(2);
      expect(imported.items.map((item) => item.case.expectationKinds.toSorted())).toEqual([
        ["mustInclude", "mustNot"],
        ["mustInclude", "mustNot"],
      ]);

      const createdRun = yield* call("evaluation run create", () =>
        evaluations.createEvaluationRun(
          {
            caseTimeoutSeconds: 300,
            concurrency: 2,
            datasetId: dataset.id,
            kind: "dataset-replay",
            scoreDefinitionIds,
            target: { agentReleaseId: publicId(baseline.releaseId), type: "release" },
          },
          { idempotencyKey: `${runKey}:run` },
        ),
      );
      const run = yield* call("evaluation run wait", () =>
        evaluations.waitForEvaluationRun(createdRun.id, { timeoutMs: WAIT_TIMEOUT_MS }),
      );
      expect(run.status, JSON.stringify(run.error)).toBe("completed");
      expect(run.counts.scored).toBe(2);
      const results = yield* call("evaluation run results", () =>
        evaluations.listEvaluationRunResults(run.id, { limit: 10 }),
      );
      expect(results.items).toHaveLength(2);
      for (const result of results.items) {
        expect(result.status).toBe("scored");
        expect(result.scores.length).toBeGreaterThan(0);
        const judgeScore = result.scores.find((score) => score.scoreDefinitionId === judge.id);
        expect(judgeScore, `judge score ${JSON.stringify(judgeScore)}`).toMatchObject({
          executionStatus: "succeeded",
        });
      }
      const traceId = results.items.find((result) => result.traceId)?.traceId;
      if (!traceId) throw new Error("No evaluation case result carried a trace ID.");
      const traceScores = yield* call("trace score results", () =>
        evaluations.listTraceScoreResults(traceId, { limit: 20 }),
      );
      expect(traceScores.items.length).toBeGreaterThan(0);
      expect(traceScores.items.every((score) => score.traceId === traceId)).toBe(true);

      const createdComparison = yield* call("release comparison create", () =>
        evaluations.createReleaseComparison(
          {
            baselineReleaseId: publicId(baseline.releaseId),
            candidateReleaseId: publicId(candidate.releaseId),
            caseTimeoutSeconds: 300,
            concurrency: 2,
            datasetId: dataset.id,
            scoreDefinitionIds,
          },
          { idempotencyKey: `${runKey}:comparison` },
        ),
      );
      const comparison = yield* call("release comparison wait", () =>
        evaluations.waitForReleaseComparison(createdComparison.id, { timeoutMs: WAIT_TIMEOUT_MS }),
      );
      expect(comparison.status, JSON.stringify(comparison.error)).toBe("completed");
      expect(comparison.gateMode).toBe("advisory");
      expect(["pass", "fail", "error"]).toContain(comparison.verdict);
      const report = comparison.report;
      if (!report) throw new Error("Completed release comparison carried no report.");
      expect(report.json.downloadUrl).toMatch(/^https:\/\//u);
      expect(report.markdown.downloadUrl).toMatch(/^https:\/\//u);
      const markdown = yield* Effect.tryPromise({
        try: async () => {
          const response = await fetch(report.markdown.downloadUrl, {
            signal: AbortSignal.timeout(60_000),
          });
          if (!response.ok) throw new Error(`Report download returned HTTP ${response.status}.`);
          return response.text();
        },
        catch: (cause) => new Error("Comparison markdown report download failed.", { cause }),
      });
      expect(markdown).toContain(comparison.verdict!);
    }).pipe(Effect.provide(CliProcessLive)),
  45 * 60_000,
);
