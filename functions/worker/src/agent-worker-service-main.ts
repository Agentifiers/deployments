import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { SQSClient } from "@aws-sdk/client-sqs";
import { agentWorkerServiceConfig } from "./agent-worker-service-config.ts";
import { failureChain } from "./failure-log.ts";
import { processAgentRunQueueDelivery } from "./queue.ts";
import { createAgentRunQueuePoller } from "./queue-poller.ts";
import { createWorkerDrain } from "./worker-drain.ts";
import { createAgentRunWorkerDependencies } from "./worker-dependencies.ts";
import { createRunSlotUtilizationMetrics } from "./worker-metrics.ts";

/**
 * ECS Fargate `agent-worker` entry: long-polls the agent-run FIFO queue until SIGTERM, then
 * drains (checkpoint at safe boundaries, requeue the rest at the drain deadline) and exits.
 */
async function main(): Promise<void> {
  const config = agentWorkerServiceConfig(process.env);
  const drain = createWorkerDrain({ timeoutMs: config.drainTimeoutMs });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      drain.start();
      console.info("Agent worker draining.", {
        drainDeadline: new Date(drain.deadline()!).toISOString(),
        signal,
      });
    });
  }
  const dependencies = {
    ...(await createAgentRunWorkerDependencies()),
    hostDrain: drain,
  };
  const poller = createAgentRunQueuePoller({
    client: new SQSClient({}),
    drain,
    maxConcurrentRuns: config.maxConcurrentRuns,
    processRecord: (record, draining) =>
      processAgentRunQueueDelivery(record, dependencies, draining),
    queueUrl: config.queueUrl,
  });
  const metrics =
    config.metrics &&
    createRunSlotUtilizationMetrics({
      client: new CloudWatchClient({}),
      inFlightRuns: poller.inFlightRuns,
      maxConcurrentRuns: config.maxConcurrentRuns,
      ...config.metrics,
    });
  metrics?.start();
  console.info("Agent worker started.", {
    maxConcurrentRuns: config.maxConcurrentRuns,
    workerId: dependencies.workerId,
  });
  await poller.run();
  await metrics?.stop();
  drain.dispose();
  console.info("Agent worker drained.");
}

try {
  await main();
  process.exit(0);
} catch (cause) {
  console.error("Agent worker stopped on a fatal error.", { failure: failureChain(cause) });
  process.exit(1);
}
