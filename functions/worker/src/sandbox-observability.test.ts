import { marshall } from "@aws-sdk/util-dynamodb";
import {
  makeIdGenerator,
  makeSandboxWorkspacePersistence,
  tableForItemType,
  type DynamoDatabaseService,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import {
  makeSandboxManager,
  type CreateSandboxInput,
  type SandboxProvider,
} from "@deployments-ai/sandbox-hosts";
import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  processObservabilityDynamoStream,
  type ObservabilityNormalizerRuntimeDependencies,
} from "./observability-normalizer-main.ts";
import { acquireThreadSandbox, createRunEphemeralSandbox } from "./sandbox-file-runtime-tools.ts";
import type { ThreadSandboxSnapshotStore } from "./thread-sandbox/snapshot-store.ts";
import { makeThreadSandboxWorkspace } from "./thread-sandbox/workspace.ts";

const id = (suffix: string) => `01J000000000000000000000${suffix}` as Ulid;
const RUN_ID = id("07");
const THREAD_ID = id("08");
const TOOL_CALL_ID = id("09");
const TRACE_ID = "0123456789abcdef0123456789abcdef";
const RUN_SPAN_ID = "0123456789abcdef";

type Pins =
  | {
      readonly agentDefinitionId: Ulid;
      readonly agentDeploymentId: Ulid;
      readonly agentReleaseId: Ulid;
    }
  | { readonly executionBindingId: Ulid; readonly executionPurpose: "evaluation" | "preview" };

const CUSTOMER: Pins = {
  agentDefinitionId: id("01"),
  agentDeploymentId: id("02"),
  agentReleaseId: id("03"),
};
const PREVIEW: Pins = { executionBindingId: id("0B"), executionPurpose: "preview" };

function request(pins: Pins, mode: "run-ephemeral" | "thread-persistent") {
  return {
    ...pins,
    agentManifestHash: "sha256:manifest",
    captureMode: "metadata-only" as const,
    decision: { action: "allow" as const, reason: "test", toolCallId: TOOL_CALL_ID },
    effect: "execute" as const,
    environmentId: id("04"),
    idempotencyKey: "model-call-0",
    inputSummary: "execute code",
    organizationId: id("05"),
    projectId: id("06"),
    requiredScopes: [],
    runId: RUN_ID,
    sandboxPolicy: { mode, provider: "aws_lambda_microvm" as const },
    spanId: RUN_SPAN_ID,
    threadId: THREAD_ID,
    toolName: "code.execute",
    traceId: TRACE_ID,
    workspaceId: id("0A"),
  } as Parameters<typeof createRunEphemeralSandbox>[1];
}

interface StreamWrite {
  readonly current: PlatformRecord;
  readonly previous?: PlatformRecord;
}

/** Stores records and captures every sandbox lease and meter event write as a stream change. */
function streamingDatabase() {
  const records = new Map<string, PlatformRecord>();
  const writes: StreamWrite[] = [];
  const key = (pk: string, sk: string) => `${pk}\u0000${sk}`;
  const store = (record: PlatformRecord) => {
    const previous = records.get(key(record.pk, record.sk));
    records.set(key(record.pk, record.sk), record);
    if (record.itemType === "sandbox-lease" || record.itemType === "meter-event") {
      writes.push({ current: record, ...(previous ? { previous } : {}) });
    }
  };
  const database: DynamoDatabaseService = {
    deleteRecord: async (record) => {
      records.delete(key(record.pk, record.sk));
    },
    getRecord: async (_table, requested) => records.get(key(requested.pk, requested.sk)),
    putRecord: async (record) => store(record),
    queryRecords: async () => ({ items: [] }),
    transactWrite: async (operations) => {
      for (const operation of operations) {
        if (operation.kind === "put") store(operation.record);
      }
    },
  } as DynamoDatabaseService;
  return { database, writes };
}

function lambdaProvider(creates: CreateSandboxInput[]): SandboxProvider {
  return {
    checkpoint: async () => {
      throw new Error("not reached");
    },
    create: async (input) => {
      creates.push(input);
      return {
        environmentId: input.environmentId,
        executionTargetId: input.executionTargetId,
        executionTargetKind: input.executionTargetKind,
        externalSandboxId: `microvm-${input.allocationId}`,
        isolationMode: input.isolationMode,
        organizationId: input.organizationId,
        projectId: input.projectId,
        provider: "aws_lambda_microvm",
        status: "ready",
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      };
    },
    destroy: async () => undefined,
    download: async () => new ReadableStream<Uint8Array>(),
    exec: async () => ({ durationMs: 1, exitCode: 0, stderr: "", stdout: "" }),
    name: "aws_lambda_microvm",
    resume: async () => {
      throw new Error("not reached");
    },
    upload: async () => undefined,
  };
}

function harness() {
  const { database, writes } = streamingDatabase();
  const creates: CreateSandboxInput[] = [];
  let clock = Date.parse("2026-09-29T23:00:00.000Z");
  const now = () => (clock += 1_000);
  const manager = makeSandboxManager(lambdaProvider(creates), database, makeIdGenerator(), {
    now,
    onSandboxCapacityRejected: () => {},
    onStaleCapacityRecovered: () => {},
    organizationSandboxLimit: async () => 16,
  });
  let nextId = 0x10;
  const threadSandbox = makeThreadSandboxWorkspace({
    generateId: async () => id((nextId++).toString(16).toUpperCase()),
    manager,
    now: () => clock,
    persistence: makeSandboxWorkspacePersistence(database),
    providerName: "aws_lambda_microvm",
    snapshots: {} as ThreadSandboxSnapshotStore,
  });
  return { creates, manager, threadSandbox, writes };
}

interface NormalizedFact {
  readonly factType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly trace?: Readonly<Record<string, unknown>>;
}

interface NormalizationResult {
  readonly facts: readonly NormalizedFact[];
  readonly failures: readonly unknown[];
  readonly quarantined: readonly unknown[];
}

/**
 * Replays the captured writes, then a retention REMOVE of each final record, through the
 * normalizer's DynamoDB stream entry point.
 */
async function normalize(writes: readonly StreamWrite[]): Promise<NormalizationResult> {
  const quarantined: unknown[] = [];
  const facts: NormalizedFact[] = [];
  const dependencies: ObservabilityNormalizerRuntimeDependencies = {
    now: () => new Date("2026-09-30T00:00:00.000Z"),
    organizationExists: async () => true,
    quarantine: async (_record, _table, cause) => {
      quarantined.push(cause);
      return "retry";
    },
    writeFacts: async (written) => {
      for (const fact of written) {
        // The normalizer serialized these facts from its own typed values.
        const parsed: NormalizedFact = JSON.parse(Buffer.from(fact.data).toString("utf8"));
        facts.push(parsed);
      }
      return [];
    },
  };
  const finalRecords = new Map<string, PlatformRecord>();
  for (const write of writes)
    finalRecords.set(`${write.current.pk}/${write.current.sk}`, write.current);
  const changes = [
    ...writes.map((write) => ({
      eventName: write.previous ? ("MODIFY" as const) : ("INSERT" as const),
      newImage: write.current,
      oldImage: write.previous,
    })),
    ...[...finalRecords.values()].map((record) => ({
      eventName: "REMOVE" as const,
      newImage: undefined,
      oldImage: record,
    })),
  ];
  const failures: unknown[] = [];
  for (const [index, change] of changes.entries()) {
    const record = change.newImage ?? change.oldImage!;
    const table = record.itemType === "meter-event" ? "usage" : "execution";
    expect(tableForItemType(record.itemType)).toBe(table);
    const result = await processObservabilityDynamoStream(
      {
        Records: [
          {
            dynamodb: {
              ...(change.newImage
                ? { NewImage: marshall(change.newImage, { removeUndefinedValues: true }) }
                : {}),
              ...(change.oldImage
                ? { OldImage: marshall(change.oldImage, { removeUndefinedValues: true }) }
                : {}),
              SequenceNumber: String(100 + index),
            },
            eventID: `event-${index}`,
            eventName: change.eventName,
            eventSourceARN: `arn:aws:dynamodb:us-east-2:123:table/${table}/stream/1`,
          },
        ],
      },
      table,
      dependencies,
    );
    failures.push(...result.batchItemFailures);
  }
  return { facts, failures, quarantined };
}

function expectRunTracedFacts(result: NormalizationResult) {
  expect(result.quarantined).toEqual([]);
  expect(result.failures).toEqual([]);
  const types = result.facts.map((fact) => fact.factType);
  expect(types).toContain("span.finalized");
  expect(types).toContain("usage.recorded");
  expect(types).toContain("record.deleted");
  for (const fact of result.facts) {
    expect(fact.trace).toMatchObject({ runId: RUN_ID, sessionId: THREAD_ID, traceId: TRACE_ID });
  }
  expect(
    result.facts
      .filter((fact) => fact.factType === "usage.recorded")
      .flatMap((fact) => (typeof fact.payload.metric === "string" ? [fact.payload.metric] : []))
      .sort(),
  ).toEqual(["sandbox_memory_mib_ms", "sandbox_ms", "sandbox_vcpu_ms"]);
}

const expectedObservability = {
  captureMode: "metadata-only",
  runSpanId: RUN_SPAN_ID,
  sessionId: THREAD_ID,
  traceId: TRACE_ID,
  workspaceId: id("0A"),
};

describe("run-owned sandbox observability", () => {
  for (const [label, pins, targetKind] of [
    ["customer", CUSTOMER, "agent-deployment"],
    ["preview", PREVIEW, "execution-binding"],
  ] as const) {
    test(`per-call run-ephemeral sandboxes of ${label} runs normalize into run-traced facts`, async () => {
      const h = harness();
      const sandbox = await createRunEphemeralSandbox(
        h.manager,
        request(pins, "run-ephemeral"),
        { mode: "run-ephemeral", provider: "aws_lambda_microvm" },
        "code.execute",
      );
      await Effect.runPromise(h.manager.destroy(sandbox));

      const leases = h.writes.filter((write) => write.current?.itemType === "sandbox-lease");
      expect(leases.length).toBeGreaterThan(1);
      for (const write of leases) {
        expect(write.current?.data).toMatchObject({
          executionTargetKind: targetKind,
          id: TOOL_CALL_ID,
          observability: expectedObservability,
          runId: RUN_ID,
        });
      }
      expectRunTracedFacts(await normalize(h.writes));
    });

    test(`thread-persistent sandboxes of ${label} runs normalize into run-traced facts`, async () => {
      const h = harness();
      const sandbox = await acquireThreadSandbox(
        h.threadSandbox,
        request(pins, "thread-persistent"),
        "code.execute",
      );
      await Effect.runPromise(h.manager.destroy(sandbox));

      expect(h.creates).toHaveLength(1);
      expect(h.creates[0]).toMatchObject({
        executionTargetKind: targetKind,
        isolationMode: "thread-persistent",
        observability: expectedObservability,
        runId: RUN_ID,
      });
      expectRunTracedFacts(await normalize(h.writes));
    });
  }

  test("refuses to allocate a run sandbox without the run's trace context", async () => {
    const h = harness();
    const untraced = {
      ...request(CUSTOMER, "run-ephemeral"),
      agentManifestHash: undefined,
      captureMode: undefined,
      spanId: undefined,
      traceId: undefined,
    } as Parameters<typeof createRunEphemeralSandbox>[1];

    expect(
      createRunEphemeralSandbox(
        h.manager,
        untraced,
        { mode: "run-ephemeral", provider: "aws_lambda_microvm" },
        "code.execute",
      ),
    ).rejects.toThrow("code.execute sandboxes require the agent run's trace context.");
    expect(acquireThreadSandbox(h.threadSandbox, untraced, "code.execute")).rejects.toThrow(
      "code.execute sandboxes require the agent run's trace context.",
    );
    expect(h.creates).toEqual([]);
    expect(h.writes).toEqual([]);
  });
});
