import { expect, test } from "bun:test";
import { makeObservabilityFact } from "@deployments-ai/observability";
import { processObservabilityKinesis } from "./observability-projector-main.ts";

test("routes Kinesis facts to Firehose and reports partial failures", async () => {
  const fact = makeObservabilityFact({
    captureMode: "metadata-only",
    factType: "usage.recorded",
    normalizedAt: "2026-07-28T12:00:02.000Z",
    occurredAt: "2026-07-28T12:00:01.000Z",
    payload: {
      idempotencyKey: "usage-1",
      metric: "model_tokens",
      quantity: 5,
      source: "model-gateway",
      unit: "tokens",
    },
    scope: {
      environmentId: "env",
      organizationId: "org",
      projectId: "project",
    },
    source: {
      recordId: "usage-1",
      recordType: "meter-event",
      recordVersion: 0,
      table: "usage",
    },
    trace: {
      runId: "run",
      sessionId: "thread",
      spanId: "0123456789abcdef",
      traceId: "0123456789abcdef0123456789abcdef",
    },
  });
  const destinations: string[] = [];
  const checkpoints: unknown[] = [];
  const event = {
    Records: [
      {
        eventID: "shardId-000000000000:200",
        eventSourceARN: "arn:aws:kinesis:us-east-2:123:stream/agent-observability-facts",
        kinesis: {
          data: Buffer.from(JSON.stringify(fact)).toString("base64"),
          sequenceNumber: "200",
        },
      },
    ],
  };

  const result = await processObservabilityKinesis(event, {
    checkpoint: async (source) => void checkpoints.push(source),
    now: () => new Date("2026-07-28T12:00:03.000Z"),
    write: async (destination) => {
      destinations.push(destination);
      return [0];
    },
  });

  expect(destinations).toEqual(["usage"]);
  expect(checkpoints).toEqual([]);
  expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "200" }] });

  await processObservabilityKinesis(event, {
    checkpoint: async (source) => void checkpoints.push(source),
    now: () => new Date("2026-07-28T12:00:03.000Z"),
    write: async () => [],
  });
  expect(checkpoints).toEqual([
    {
      sequenceNumber: "200",
      shardId: "shardId-000000000000",
      streamArn: "arn:aws:kinesis:us-east-2:123:stream/agent-observability-facts",
    },
  ]);
});
