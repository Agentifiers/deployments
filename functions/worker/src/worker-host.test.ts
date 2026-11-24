import { describe, expect, it } from "bun:test";
import { PutMetricDataCommand, type CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { isRuntimeHostShutdown } from "@deployments-ai/agent-runtime";
import { processAgentRun } from "./agent-run-processor.ts";
import {
  abandonedRunWithLease,
  fixtures,
  inMemoryDatabase,
  workerDependencies,
} from "./agent-run.fixture.ts";
import { agentWorkerServiceConfig } from "./agent-worker-service-config.ts";
import { createWorkerDrain } from "./worker-drain.ts";
import { agentWorkerProcessId } from "./worker-env.ts";
import { createRunSlotUtilizationMetrics } from "./worker-metrics.ts";

const QUEUE_URL = "https://sqs.us-east-2.amazonaws.com/123456789012/agent-runtime.fifo";

describe("worker drain", () => {
  it("fixes the deadline at the first start and aborts with a host-shutdown reason at it", () => {
    let clock = 1_000;
    let fireDeadline: (() => void) | undefined;
    const delays: number[] = [];
    const drain = createWorkerDrain({
      now: () => clock,
      schedule: (callback, delayMs) => {
        fireDeadline = callback;
        delays.push(delayMs);
        return () => undefined;
      },
      timeoutMs: 100_000,
    });

    expect(drain.deadline()).toBeUndefined();
    drain.start();
    clock = 50_000;
    drain.start();

    expect(drain.deadline()).toBe(101_000);
    expect(delays).toEqual([100_000]);
    expect(drain.signal.aborted).toBe(false);
    fireDeadline!();
    expect(isRuntimeHostShutdown(drain.signal)).toBe(true);
  });
});

describe("run slot utilization metric", () => {
  it("publishes in-flight runs as a percent of slots now, every minute, and once at shutdown", async () => {
    const published: unknown[] = [];
    let inFlight = 0;
    let tick: (() => void) | undefined;
    const metrics = createRunSlotUtilizationMetrics({
      client: {
        send: async (command: unknown) => {
          if (!(command instanceof PutMetricDataCommand)) throw new Error("Unexpected command.");
          published.push(command.input);
          return {};
        },
      } as unknown as Pick<CloudWatchClient, "send">,
      inFlightRuns: () => inFlight,
      maxConcurrentRuns: 16,
      namespace: "DeploymentsAI/AgentWorker",
      now: () => new Date("2026-10-01T00:00:00.000Z"),
      repeat: (callback, intervalMs) => {
        expect(intervalMs).toBe(60_000);
        tick = callback;
        return () => {
          tick = undefined;
        };
      },
      serviceName: "agent-worker",
    });

    metrics.start();
    inFlight = 4;
    tick!();
    inFlight = 16;
    await metrics.stop();

    expect(tick).toBeUndefined();
    expect(published).toEqual(
      [0, 25, 100].map((value) => ({
        MetricData: [
          {
            Dimensions: [{ Name: "ServiceName", Value: "agent-worker" }],
            MetricName: "RunSlotUtilization",
            Timestamp: new Date("2026-10-01T00:00:00.000Z"),
            Unit: "Percent",
            Value: value,
          },
        ],
        Namespace: "DeploymentsAI/AgentWorker",
      })),
    );
  });

  it("logs and drops a failed publication", async () => {
    const metrics = createRunSlotUtilizationMetrics({
      client: {
        send: async () => {
          throw new Error("throttled");
        },
      } as unknown as Pick<CloudWatchClient, "send">,
      inFlightRuns: () => 1,
      maxConcurrentRuns: 2,
      namespace: "DeploymentsAI/AgentWorker",
      repeat: () => () => undefined,
      serviceName: "agent-worker",
    });

    expect(metrics.stop()).resolves.toBeUndefined();
  });
});

describe("agent worker service configuration", () => {
  const env = {
    DEPLOYMENTS_AI_AGENT_RUN_QUEUE_URL: QUEUE_URL,
    DEPLOYMENTS_AI_AGENT_WORKER_MAX_CONCURRENT_RUNS: "16",
  };

  it("defaults the drain to 100 s and publishes no metrics without a namespace", () => {
    expect(agentWorkerServiceConfig(env)).toEqual({
      drainTimeoutMs: 100_000,
      maxConcurrentRuns: 16,
      queueUrl: QUEUE_URL,
    });
    expect(
      agentWorkerServiceConfig({
        ...env,
        DEPLOYMENTS_AI_AGENT_WORKER_DRAIN_TIMEOUT_SECONDS: "60",
        DEPLOYMENTS_AI_AGENT_WORKER_METRIC_NAMESPACE: "DeploymentsAI/AgentWorker",
        DEPLOYMENTS_AI_AGENT_WORKER_SERVICE_NAME: "agent-worker",
      }),
    ).toMatchObject({
      drainTimeoutMs: 60_000,
      metrics: { namespace: "DeploymentsAI/AgentWorker", serviceName: "agent-worker" },
    });
  });

  it.each([
    [{ DEPLOYMENTS_AI_AGENT_RUN_QUEUE_URL: "" }, "DEPLOYMENTS_AI_AGENT_RUN_QUEUE_URL is required."],
    [
      { DEPLOYMENTS_AI_AGENT_RUN_QUEUE_URL: QUEUE_URL.replace(".fifo", "") },
      "must target a FIFO queue",
    ],
    [{ DEPLOYMENTS_AI_AGENT_WORKER_MAX_CONCURRENT_RUNS: "65" }, "integer from 1 to 64"],
    [{ DEPLOYMENTS_AI_AGENT_WORKER_MAX_CONCURRENT_RUNS: "0" }, "integer from 1 to 64"],
    [{ DEPLOYMENTS_AI_AGENT_WORKER_DRAIN_TIMEOUT_SECONDS: "111" }, "integer from 1 to 110"],
    [
      { DEPLOYMENTS_AI_AGENT_WORKER_METRIC_NAMESPACE: "DeploymentsAI/AgentWorker" },
      "DEPLOYMENTS_AI_AGENT_WORKER_SERVICE_NAME is required.",
    ],
  ])("rejects %p", (override, message) => {
    expect(() => agentWorkerServiceConfig({ ...env, ...override })).toThrow(message);
  });
});

describe("agent worker identity", () => {
  it("names the process after its ECS task, falling back to the hostname", () => {
    expect(
      agentWorkerProcessId(
        {
          ECS_CONTAINER_METADATA_URI_V4:
            "http://169.254.170.2/v4/0123456789abcdef0123456789abcdef-2495160603",
        },
        "ip-10-0-0-1",
      ),
    ).toMatch(/^agent-worker:0123456789abcdef0123456789abcdef:[0-9a-f-]{36}$/u);
    expect(agentWorkerProcessId({}, "ip-10-0-0-1")).toMatch(
      /^agent-worker:ip-10-0-0-1:[0-9a-f-]{36}$/u,
    );
  });
});

describe("running claim timeout", () => {
  it.each([
    [179_000, "keeps the claim of a worker heard from within three minutes"],
    [180_000, "reclaims a run whose worker went silent for three minutes"],
  ])("after %p ms of silence %s", async (silenceMs) => {
    const fixture = fixtures();
    const abandoned = abandonedRunWithLease(fixture);
    const memory = inMemoryDatabase([
      fixture.release,
      fixture.deployment,
      fixture.thread,
      fixture.userMessage,
      abandoned.run,
      abandoned.lease,
    ]);
    const base = workerDependencies(memory.database);
    let clock = Date.parse(abandoned.run.data.heartbeatAt!) + silenceMs;
    const dependencies = { ...base.dependencies, now: () => new Date(clock++) };

    const processing = processAgentRun(fixture.queue, dependencies);

    if (silenceMs < 180_000) expect(processing).rejects.toThrow("active claim");
    else expect(processing).resolves.toMatchObject({ action: "completed" });
  });
});
