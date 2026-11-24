import { expect } from "@effect/vitest";
import { createPlatformSdk, PlatformApiError } from "@agentifiers/deployments-sdk";
import { Effect } from "effect";
import type { CliProcessService } from "../harness/cli-process.ts";
import { eventually } from "../harness/eventually.ts";
import {
  acquireLiveAgent,
  numberField,
  parseCli,
  record,
  stringField,
} from "../harness/live-agent.ts";
import type { ScopedE2eConfig } from "../harness/live-config.ts";
import { liveAgentModel } from "../harness/live-model.ts";

type JsonRecord = Record<string, unknown>;

/** Trace facts reach ClickHouse through Kinesis and the hot-plane writer, so allow ingest lag. */
const TRACE_VISIBLE_TIMEOUT_MS = 10 * 60_000;
const RUN_COMPLETION_TIMEOUT_MS = 5 * 60_000;

export const ERASURE_COMPLETION_TIMEOUT_MS = 55 * 60_000;

const MEMORY_SEARCH_BACKUP_EXPIRY_MS = (14 * 24 + 1) * 60 * 60_000;

function call<T>(label: string, request: () => Promise<{ readonly data: T }>) {
  return Effect.tryPromise({
    try: async () => (await request()).data,
    catch: (cause) => new Error(`${label} failed.`, { cause }),
  });
}

function promptOnlyManifest(runKey: string) {
  return {
    apiVersion: "agents.deployments.ai/v1",
    kind: "Agent",
    metadata: { key: runKey, name: `E2E erasure ${runKey}`, version: "1.0.0" },
    spec: {
      instructions: "Reply with one short sentence. Never call tools.",
      model: liveAgentModel.model,
      runtime: liveAgentModel.runtime,
      sandbox: { mode: "none" },
      triggers: ["api"],
    },
  };
}

function createTenantScope(
  cli: CliProcessService,
  config: ScopedE2eConfig,
  organizationId: string,
  runKey: string,
) {
  const common = ["--live", "--org", organizationId, "--json", "--no-color"];
  const env = {
    get DEPLOYMENTS_API_KEY() {
      return config.platformCredential.token;
    },
    DEPLOYMENTS_API_URL: config.apiUrl,
    DEPLOYMENTS_LIVE: "1",
  };
  const slug = `e2e-erasure-${runKey.slice(-12)}`;
  return Effect.gen(function* () {
    const project = parseCli(
      yield* cli.run({
        args: [
          "project",
          "create",
          "--name",
          `E2E erasure ${runKey}`,
          "--slug",
          slug,
          "--idempotency-key",
          `${runKey}:project`,
          ...common,
        ],
        env,
      }),
      "erasure project create",
    );
    const projectId = stringField(project, "id", "erasure project");
    const environment = parseCli(
      yield* cli.run({
        args: [
          "env",
          "create",
          "--name",
          `E2E erasure ${runKey}`,
          "--slug",
          slug,
          "--type",
          "development",
          "--project",
          projectId,
          "--idempotency-key",
          `${runKey}:environment`,
          ...common,
        ],
        env,
      }),
      "erasure environment create",
    );
    return {
      environmentId: stringField(environment, "id", "erasure environment"),
      projectId,
    };
  });
}

/**
 * Seeds the throwaway organization with a project, environment, deployed agent, and one
 * completed run whose trace is visible in the hot plane. The project and environment are
 * left for tenant erasure; agent resources and credentials are released when this scope
 * closes so no deployment or run is active when erasure is requested.
 */
export function seedObservedRun(
  cli: CliProcessService,
  config: ScopedE2eConfig,
  organizationId: string,
  runKey: string,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* createTenantScope(cli, config, organizationId, runKey);
      const tenantConfig: ScopedE2eConfig = { ...config, ...scope, organizationId };
      const agent = yield* acquireLiveAgent(cli, tenantConfig, runKey, promptOnlyManifest(runKey), {
        serviceAccountScopes: ["observability:read"],
      });
      const context = { ...scope, organizationId };
      const sdk = createPlatformSdk({ apiKey: agent.runtimeApiKey, baseUrl: config.apiUrl });
      const runtime = sdk.runtime(context);
      const observability = sdk.observability(context);

      const submitted = yield* call("erasure run submit", () =>
        runtime.runs.submit(
          agent.deploymentId,
          { content: "Say hello before this organization is erased." },
          { idempotencyKey: `${runKey}:run` },
        ),
      );
      const runId = submitted.run.id;
      const threadId = submitted.run.threadId;
      const completed = yield* eventually(
        {
          intervalMs: 2_000,
          label: "erasure run completion",
          timeoutMs: RUN_COMPLETION_TIMEOUT_MS,
        },
        call("erasure run read", () => runtime.runs.get(threadId, runId)).pipe(
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

      const trace = yield* eventually(
        {
          intervalMs: 5_000,
          label: "erasure run trace visible",
          timeoutMs: TRACE_VISIBLE_TIMEOUT_MS,
        },
        Effect.tryPromise({
          try: async () => (await observability.getRunTrace(runId)).data,
          catch: (cause) => cause,
        }).pipe(
          Effect.map((summary) => (summary.finalized_at ? summary : undefined)),
          Effect.catch((cause) =>
            cause instanceof PlatformApiError && cause.problem.status === 404
              ? Effect.succeed(undefined)
              : Effect.fail(new Error("Erasure run trace read failed.", { cause })),
          ),
        ),
      );
      expect(trace.root_run_id).toBe(runId);
      expect(trace.project_id).toBe(scope.projectId);
      expect(trace.environment_id).toBe(scope.environmentId);
      return { ...scope, runId, traceId: trace.trace_id };
    }),
  );
}

function timestamp(value: JsonRecord, field: string, label: string) {
  const parsed = Date.parse(stringField(value, field, label));
  expect(Number.isFinite(parsed), `${label}.${field} is ISO-8601`).toBe(true);
  return parsed;
}

/** Asserts the completed erasure purged hot-plane and Iceberg observability rows. */
export function expectObservabilityErasure(erased: JsonRecord) {
  const summary = record(erased.summary, "erasure summary");
  const observability = record(summary.observability, "erasure summary.observability");
  expect(numberField(observability, "clickhouseRowsDeleted", "observability")).toBeGreaterThan(0);
  expect(numberField(observability, "icebergRowsDeleted", "observability")).toBeGreaterThan(0);
  const physicalRemovalBy = timestamp(observability, "physicalRemovalBy", "observability");
  const backupsExpireBy = timestamp(observability, "backupsExpireBy", "observability");
  if (typeof erased.completedAt === "string") {
    const completedAt = timestamp(erased, "completedAt", "erasure");
    expect(physicalRemovalBy).toBeGreaterThan(completedAt);
    expect(backupsExpireBy).toBeGreaterThan(completedAt);
  }
}

export function expectMemorySearchErasure(erased: JsonRecord) {
  const summary = record(erased.summary, "erasure summary");
  const memorySearch = record(summary.memorySearch, "erasure summary.memorySearch");
  const backupsExpireBy = timestamp(memorySearch, "backupsExpireBy", "memorySearch");
  const completedAt = timestamp(erased, "completedAt", "erasure");
  expect(backupsExpireBy).toBeGreaterThan(completedAt);
  expect(backupsExpireBy).toBeLessThanOrEqual(completedAt + MEMORY_SEARCH_BACKUP_EXPIRY_MS);
  expect(backupsExpireBy).toBeGreaterThan(
    completedAt + MEMORY_SEARCH_BACKUP_EXPIRY_MS - ERASURE_COMPLETION_TIMEOUT_MS,
  );
}
