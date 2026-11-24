import type { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { describe, expect, test } from "bun:test";
import type { AgentRunWorkerDependencies } from "./types.ts";
import {
  cachedAgentRunWorkerDependencies,
  createAgentRunWorkerDependencies,
} from "./worker-dependencies.ts";
import { createCompletedRunMemoryFlushEnqueuer } from "./completed-run-memory-flush.ts";
import { appsRuntimeConfig, runtimeToolAvailable, WORKER_ENV } from "./worker-env.ts";
import { MemoryPlatformError, type MemoryPlatform } from "@deployments-ai/memory";
import { fixtures } from "./agent-run.fixture.ts";
import { SANDBOX_FILE_TOOL_NAMES } from "@deployments-ai/tools";

const workerMainSource = await Bun.file(new URL("worker-dependencies.ts", import.meta.url)).text();

describe("worker dependency initialization", () => {
  test("retries after a rejected initialization promise", async () => {
    let attempts = 0;
    const expected = { workerId: "worker-recovered" } as AgentRunWorkerDependencies;
    const create = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("secret manager unavailable");
      return expected;
    };

    expect(cachedAgentRunWorkerDependencies(create)).rejects.toThrow("secret manager unavailable");
    expect(cachedAgentRunWorkerDependencies(create)).resolves.toBe(expected);
    expect(attempts).toBe(2);
  });

  test("fails worker initialization when its sandbox manager refuses the install's cost policy", async () => {
    const env = {
      DEPLOYMENTS_AI_AGENT_RUN_MAX_RECEIVE_COUNT: "5",
      DEPLOYMENTS_AI_AGENT_RUN_QUEUE_URL:
        "https://sqs.us-east-1.amazonaws.com/000000000000/agent-run.fifo",
      DEPLOYMENTS_AI_AGENT_RUN_VISIBILITY_TIMEOUT_SECONDS: "60",
      DEPLOYMENTS_AI_ARTIFACT_BUCKET: "artifacts",
      DEPLOYMENTS_AI_ARTIFACT_KMS_KEY_ARN:
        "arn:aws:kms:us-east-1:000000000000:key/00000000-0000-0000-0000-000000000001",
      DEPLOYMENTS_AI_AUTOMATION_FAILURE_QUEUE_ARN:
        "arn:aws:sqs:us-east-1:000000000000:automation-failures",
      DEPLOYMENTS_AI_CREDENTIAL_KMS_KEY_ARN:
        "arn:aws:kms:us-east-1:000000000000:key/00000000-0000-0000-0000-000000000002",
      DEPLOYMENTS_AI_DURABLE_STREAMS_AUTH_SECRET_ARN:
        "arn:aws:secretsmanager:us-east-1:000000000000:secret:durable-streams",
      DEPLOYMENTS_AI_DURABLE_STREAMS_URL: "https://streams.example.com",
      DEPLOYMENTS_AI_HEARTBEAT_FIRE_LAMBDA_ARN:
        "arn:aws:lambda:us-east-1:000000000000:function:heartbeat-fire",
      DEPLOYMENTS_AI_MODEL_GATEWAY_BASE_URL: "https://gateway.example.com",
      DEPLOYMENTS_AI_MODEL_GATEWAY_RUN_TOKEN_ISSUER: "run-token-issuer",
      DEPLOYMENTS_AI_MODEL_GATEWAY_TOKEN_ISSUER: "token-issuer",
      DEPLOYMENTS_AI_SANDBOX_USAGE_COST_POLICY: '{"vcpuHourUsdMicros":1000000001}',
      DEPLOYMENTS_AI_SCHEDULE_FIRE_LAMBDA_ARN:
        "arn:aws:lambda:us-east-1:000000000000:function:schedule-fire",
      DEPLOYMENTS_AI_SCHEDULER_GROUP: "automations",
      DEPLOYMENTS_AI_SCHEDULER_ROLE_ARN: "arn:aws:iam::000000000000:role/scheduler",
      DEPLOYMENTS_AI_TENANT_LIMIT_DEFAULTS: JSON.stringify({
        active_sandboxes: 8,
        api_request_burst: 40,
        api_requests_per_second: 20,
        concurrent_runs: 8,
      }),
    };
    const secretsManager = {
      send: async () => ({ SecretString: "durable-streams-token" }),
    } as unknown as SecretsManagerClient;

    const failure = await createAgentRunWorkerDependencies({ env, secretsManager }).then(
      () => "initialized",
      (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
    );

    expect(failure).toBe(
      "Sandbox costPolicy.vcpuHourUsdMicros must be a non-negative safe integer no greater than 1000000000.",
    );
  });

  test("installs memory recall, memory tools, and sandbox runtime ports", () => {
    expect(workerMainSource).toContain(
      "const builtinExecutors = createRuntimePlatformBuiltinExecutors({",
    );
    expect(workerMainSource).toContain("recallMemory: createRuntimeMemoryRecall(");
    expect(workerMainSource).toContain("await brainRecall.revalidate({");
    expect(workerMainSource).toContain(
      "const sandboxProvider = options.sandboxProvider ?? createSandboxProviderFromEnv(env)",
    );
    expect(workerMainSource).toContain("const sandboxManager = makeSandboxManager(");
    expect(workerMainSource).toContain("sandboxManager,");
    expect(workerMainSource).toContain("sandboxProvider,");
  });

  test("skips an automatic memory flush after strong access resolution finds no grant", async () => {
    const run = fixtures().run;
    const enqueue = createCompletedRunMemoryFlushEnqueuer(
      async () =>
        ({
          requiredFlush: async () => {
            throw new MemoryPlatformError(404, "flush_not_found", "Memory flush was not found.");
          },
          enqueueFlush: async () => {
            throw new MemoryPlatformError(
              409,
              "memory_space_required",
              "No compatible writable memory space exists.",
            );
          },
        }) as unknown as MemoryPlatform,
    );

    expect(enqueue(run, "agent")).resolves.toBe("unconfigured");
  });

  test("sets up default workspace memory only for an unconfigured workspace-memory flush", async () => {
    const run = fixtures().run;
    const provisioned: string[] = [];
    let granted = false;
    const enqueue = createCompletedRunMemoryFlushEnqueuer(
      async () =>
        ({
          requiredFlush: async () => {
            throw new MemoryPlatformError(404, "flush_not_found", "Memory flush was not found.");
          },
          enqueueFlush: async (_scope: unknown, _run: unknown, input: { memoryMode: string }) => {
            if (input.memoryMode === "workspace" && granted) return {};
            throw new MemoryPlatformError(409, "memory_space_required", "No space.");
          },
          provisionDefaultWorkspaceMemory: async () => {
            provisioned.push("workspace");
            granted = true;
            return true;
          },
        }) as unknown as MemoryPlatform,
    );

    expect(await enqueue(run, "agent")).toBe("unconfigured");
    expect(provisioned).toEqual([]);
    expect(await enqueue(run, "workspace")).toBe("enqueued");
    expect(provisioned).toEqual(["workspace"]);
  });

  test("keeps unexpected automatic memory flush failures retryable", async () => {
    const run = fixtures().run;
    const enqueue = createCompletedRunMemoryFlushEnqueuer(
      async () =>
        ({
          requiredFlush: async () => {
            throw new MemoryPlatformError(404, "flush_not_found", "Memory flush was not found.");
          },
          enqueueFlush: async () => {
            throw new MemoryPlatformError(500, "database_unavailable", "Database unavailable.");
          },
        }) as unknown as MemoryPlatform,
    );

    expect(enqueue(run, "agent")).rejects.toThrow("Database unavailable");
  });

  test("accepts an existing automatic flush before resolving changed grants", async () => {
    const run = fixtures().run;
    let enqueueCalls = 0;
    const enqueue = createCompletedRunMemoryFlushEnqueuer(
      async () =>
        ({
          requiredFlush: async () => ({ data: { status: "queued" } }),
          enqueueFlush: async () => {
            enqueueCalls += 1;
            throw new Error("automatic replay must not select another memory space");
          },
        }) as unknown as MemoryPlatform,
    );

    expect(enqueue(run, "agent")).resolves.toBe("enqueued");
    expect(enqueueCalls).toBe(0);
  });

  test("offers every browser tool only on the Lambda MicroVM provider", () => {
    const lambda = { [WORKER_ENV.sandboxProvider]: "aws_lambda_microvm" };
    for (const toolName of [
      "browser.capture_screenshot",
      "browser.screenshot.capture",
      "browser.session.execute",
      "browser.dom_snapshot.capture",
    ]) {
      expect(runtimeToolAvailable(lambda, toolName)).toBe(true);
      expect(runtimeToolAvailable({}, toolName)).toBe(false);
    }
    expect(
      runtimeToolAvailable(
        { DEPLOYMENTS_AI_SANDBOX_PROVIDER: "aws_lambda_microvm" },
        "code.execute",
      ),
    ).toBe(true);
    expect(runtimeToolAvailable({}, "code.execute")).toBe(false);
  });

  test("offers sandbox file tools only on the Lambda MicroVM provider", () => {
    const lambda = { [WORKER_ENV.sandboxProvider]: "aws_lambda_microvm" };
    for (const toolName of SANDBOX_FILE_TOOL_NAMES) {
      expect(runtimeToolAvailable(lambda, toolName)).toBe(true);
      expect(runtimeToolAvailable({}, toolName)).toBe(false);
    }
    expect(runtimeToolAvailable({}, "code.execute")).toBe(false);
  });

  test("offers app tools only when the apps database, bucket, and domain are all configured", () => {
    const apps = {
      APPS_BUCKET: "deployments-ai-apps",
      APPS_DATABASE_FUNCTION_NAME: "apps-database",
      APPS_DOMAIN: "apps.example.com",
    };
    const lambda = { ...apps, [WORKER_ENV.sandboxProvider]: "aws_lambda_microvm" };

    expect(
      ["app.create", "app.migrate", "app.release"].map((toolName) => [
        runtimeToolAvailable({}, toolName),
        runtimeToolAvailable(apps, toolName),
        runtimeToolAvailable(lambda, toolName),
      ]),
    ).toEqual([
      [false, true, true],
      [false, true, true],
      [false, false, true],
    ]);
    expect(appsRuntimeConfig(apps)).toEqual({
      bucket: "deployments-ai-apps",
      databaseFunctionName: "apps-database",
      domain: "apps.example.com",
    });
    expect(() => appsRuntimeConfig({ APPS_BUCKET: "deployments-ai-apps" })).toThrow(
      "APPS_DATABASE_FUNCTION_NAME, APPS_BUCKET, and APPS_DOMAIN must be set together.",
    );
  });

  test("loads optional Firecrawl secrets only from the lazy web configuration path", () => {
    expect(workerMainSource).toContain("const loadWebConfig = async () =>");
    expect(
      workerMainSource.indexOf("firecrawlApiKeySecretArn\n          ? secretString"),
    ).toBeGreaterThan(workerMainSource.indexOf("const loadWebConfig = async () =>"));
  });

  test("uses run tokens for agent generations and run-bound service tokens for Brain queries", () => {
    expect(workerMainSource).toContain(
      "gateway: async () => gatewayWith(brainCredentials(runId)),",
    );
    expect(workerMainSource).toContain(
      "generateAssistantMessage: modelGatewayGenerationPort(async () => runGateway),",
    );
    expect(workerMainSource).toContain("registry: runModelTokens,");
    expect(workerMainSource).toContain("    runModelTokens,\n");
  });
});
