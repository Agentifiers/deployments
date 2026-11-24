import { marshall } from "@aws-sdk/util-dynamodb";
import {
  makeIdGenerator,
  OrganizationRecord,
  readMonthSpend,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
} from "@deployments-ai/db";
import { makeTenancyTestDatabase } from "@deployments-ai/db/memory-testing";
import {
  makeSandboxManager,
  resolveSandboxUsageCostPolicyFromEnv,
  type SandboxManagerConfig,
  type SandboxProvider,
} from "@deployments-ai/sandbox-hosts";
import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { id } from "./agent-run.fixture.ts";
import { handler, setUsageMaterializerDatabaseForTest } from "./usage-main.ts";

const ORGANIZATION_ID = id(71);
const PROJECT_ID = id(72);
const ENVIRONMENT_ID = id(73);
const STARTED_AT = Date.parse("2026-07-23T12:00:00.000Z");
const ONE_HOUR_MS = 60 * 60 * 1_000;
const INSTALL_ENVIRONMENT = {
  DEPLOYMENTS_AI_TENANT_LIMIT_DEFAULTS: JSON.stringify({
    active_sandboxes: 8,
    api_request_burst: 40,
    api_requests_per_second: 20,
    concurrent_runs: 8,
  }),
};

type MeterEvent = Extract<PlatformRecord, { readonly itemType: "meter-event" }>;

const provider: SandboxProvider = {
  checkpoint: async () => {
    throw new Error("not reached");
  },
  create: async (input) => ({
    environmentId: input.environmentId,
    executionTargetId: input.executionTargetId,
    executionTargetKind: input.executionTargetKind,
    externalSandboxId: `microvm-${input.allocationId}`,
    isolationMode: input.isolationMode,
    organizationId: input.organizationId,
    projectId: input.projectId,
    provider: "aws_lambda_microvm",
    status: "ready",
  }),
  destroy: async () => undefined,
  download: async () => new ReadableStream<Uint8Array>(),
  exec: async () => ({ durationMs: 1, exitCode: 0, stderr: "", stdout: "" }),
  name: "aws_lambda_microvm",
  resume: async () => {
    throw new Error("not reached");
  },
  upload: async () => undefined,
};

/** Runs one default-sized sandbox for `durationMs` and returns the meter events it records. */
async function sandboxUsage(
  costPolicy: SandboxManagerConfig["costPolicy"],
  durationMs = ONE_HOUR_MS,
) {
  const records = new Map<string, PlatformRecord>();
  const database = {
    deleteRecord: async (record) => {
      records.delete(`${record.pk}\u0000${record.sk}`);
    },
    getRecord: async (_table, requested) => records.get(`${requested.pk}\u0000${requested.sk}`),
    putRecord: async (record) => {
      records.set(`${record.pk}\u0000${record.sk}`, record);
    },
    queryRecords: async () => ({ items: [] }),
    transactWrite: async (operations) => {
      for (const operation of operations) {
        if (operation.kind === "put") {
          records.set(`${operation.record.pk}\u0000${operation.record.sk}`, operation.record);
        }
      }
    },
  } as DynamoDatabaseService;
  let nextId = 100;
  let clock = STARTED_AT;
  const manager = makeSandboxManager(
    provider,
    database,
    makeIdGenerator(() => id(nextId++)),
    {
      costPolicy,
      now: () => clock,
      onSandboxCapacityRejected: () => {},
      onStaleCapacityRecovered: () => {},
      organizationSandboxLimit: async () => 8,
    },
  );
  const sandbox = await Effect.runPromise(
    manager.create({
      environmentId: ENVIRONMENT_ID,
      executionTargetId: id(74),
      executionTargetKind: "agent-deployment",
      isolationMode: "run-ephemeral",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    }),
  );
  clock += durationMs;
  await Effect.runPromise(manager.destroy(sandbox));
  return [...records.values()].filter(
    (record): record is MeterEvent => record.itemType === "meter-event",
  );
}

async function foldIntoMonthSpend(events: readonly MeterEvent[]) {
  const { database } = makeTenancyTestDatabase();
  await database.transactWrite([
    {
      kind: "put",
      record: Schema.decodeUnknownSync(OrganizationRecord)(
        withCanonicalRecordKeys({
          data: {
            createdAt: "2026-07-01T00:00:00.000Z",
            id: ORGANIZATION_ID,
            name: "Acme",
            slug: "acme",
            status: "active",
            updatedAt: "2026-07-01T00:00:00.000Z",
            version: 1,
          },
          itemType: "organization" as const,
        }),
      ),
    },
  ]);
  setUsageMaterializerDatabaseForTest(database, INSTALL_ENVIRONMENT);
  const { batchItemFailures } = await handler({
    Records: events.map((event, index) => ({
      dynamodb: {
        NewImage: marshall(event, { removeUndefinedValues: true }),
        SequenceNumber: String(500 + index),
      },
      eventName: "INSERT",
    })),
  });
  expect(batchItemFailures).toEqual([]);
  return readMonthSpend(
    database,
    ORGANIZATION_ID,
    { scope: "organization" },
    new Date("2026-07-31T00:00:00.000Z"),
  );
}

describe("install sandbox usage cost policy", () => {
  test("leaves sandbox meter events unpriced when the install sets no policy", async () => {
    const events = await sandboxUsage(resolveSandboxUsageCostPolicyFromEnv({}));

    expect(events).toEqual(await sandboxUsage(undefined));
    expect(
      events.map(({ data }) => [
        data.metric,
        data.quantity,
        data.dimensions.costUsdMicros,
        data.dimensions.funding,
      ]),
    ).toEqual([
      ["sandbox_ms", 3_600_000, undefined, undefined],
      ["sandbox_vcpu_ms", 3_600_000, undefined, undefined],
      ["sandbox_memory_mib_ms", 7_372_800_000, undefined, undefined],
    ]);
    expect(await foldIntoMonthSpend(events)).toEqual({
      asOf: "2026-07-31T00:00:00.000Z",
      operatorFundedUsdMicros: 0,
      organizationFundedUsdMicros: 0,
      periodStart: "2026-07-01T00:00:00.000Z",
      totalUsdMicros: 0,
    });
  });

  test("prices sandbox time as operator-funded spend in the organization's month", async () => {
    const events = await sandboxUsage(
      resolveSandboxUsageCostPolicyFromEnv({
        DEPLOYMENTS_AI_SANDBOX_USAGE_COST_POLICY:
          '{"memoryGiBHourUsdMicros":13200,"vcpuHourUsdMicros":99700}',
      }),
    );

    expect(
      events.map(({ data }) => [
        data.metric,
        data.dimensions.costUsdMicros,
        data.dimensions.funding,
      ]),
    ).toEqual([
      ["sandbox_ms", undefined, undefined],
      ["sandbox_vcpu_ms", 99_700, "operator"],
      ["sandbox_memory_mib_ms", 26_400, "operator"],
    ]);
    expect(await foldIntoMonthSpend(events)).toEqual({
      asOf: "2026-07-31T00:00:00.000Z",
      operatorFundedUsdMicros: 126_100,
      organizationFundedUsdMicros: 0,
      periodStart: "2026-07-01T00:00:00.000Z",
      totalUsdMicros: 126_100,
    });
  });

  test("rounds each sandbox charge to the nearest micro-dollar, half up", async () => {
    const charges = async (costPolicy: SandboxManagerConfig["costPolicy"]) =>
      (await sandboxUsage(costPolicy, 1_000)).map(({ data }) => [
        data.metric,
        data.dimensions.costUsdMicros,
      ]);

    expect(
      await charges({
        baseHourUsdMicros: 5_400,
        memoryGiBHourUsdMicros: 900,
        vcpuHourUsdMicros: 1_799,
      }),
    ).toEqual([
      ["sandbox_ms", 2],
      ["sandbox_vcpu_ms", 0],
      ["sandbox_memory_mib_ms", 1],
    ]);
    expect(await charges({ baseHourUsdMicros: 5_399 })).toEqual([
      ["sandbox_ms", 1],
      ["sandbox_vcpu_ms", undefined],
      ["sandbox_memory_mib_ms", undefined],
    ]);
  });
});
