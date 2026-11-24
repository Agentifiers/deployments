import { describe, expect, test } from "bun:test";
import {
  BudgetRecord,
  MeterEventRecord,
  findExhaustedBudget,
  prepareDynamoTransactionOperations,
  readMonthSpend,
  withCanonicalRecordKeys,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import { makeTenancyTestDatabase } from "@deployments-ai/db/memory-testing";
import { Schema } from "effect";
import { materializeMeterEvent, meterEventSpendUsdMicros } from "./index.ts";

const ORGANIZATION_ID = "01J000000000000000000000RG" as Ulid;
const PROJECT_ID = "01J00000000000000000000PRJ" as Ulid;
const ENVIRONMENTS = ["01J00000000000000000000EN1", "01J00000000000000000000EN2"] as Ulid[];

const WORKSPACE_ID = "01J00000000000000000000WS1" as Ulid;
const OTHER_WORKSPACE_ID = "01J00000000000000000000WS2" as Ulid;

function costEvent(
  id: string,
  environmentId: Ulid,
  dimensions: Readonly<Record<string, number | string>>,
  attribution: {
    readonly observabilityWorkspaceId?: Ulid | undefined;
    readonly workspaceId?: Ulid;
  } = {},
) {
  return Schema.decodeUnknownSync(MeterEventRecord)(
    withCanonicalRecordKeys({
      data: {
        dimensions,
        environmentId,
        id,
        idempotencyKey: `usage-${id}`,
        metric: "model_tokens",
        ...("observabilityWorkspaceId" in attribution
          ? {
              observability: {
                captureMode: "metadata-only",
                runSpanId: "0123456789abcdef",
                sessionId: "01J00000000000000000000THR",
                traceId: "0123456789abcdef0123456789abcdef",
                ...(attribution.observabilityWorkspaceId
                  ? { workspaceId: attribution.observabilityWorkspaceId }
                  : {}),
              },
            }
          : {}),
        occurredAt: "2026-07-23T12:34:56.000Z",
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        quantity: 10,
        source: "model-gateway",
        unit: "tokens",
        ...(attribution.workspaceId ? { workspaceId: attribution.workspaceId } : {}),
      },
      itemType: "meter-event" as const,
    }),
  );
}

describe("budget spend materialization", () => {
  test("uses ledger micros, falling back to rounded exact nano-dollars", () => {
    expect(
      meterEventSpendUsdMicros(
        costEvent("01J0000000000000000000EV01", ENVIRONMENTS[0]!, {
          costUsdMicros: 7,
          costUsdNanoDollars: 7_400,
        }),
      ),
    ).toBe(7);
    expect(
      meterEventSpendUsdMicros(
        costEvent("01J0000000000000000000EV02", ENVIRONMENTS[0]!, { costUsdNanoDollars: 2_500 }),
      ),
    ).toBe(3);
    expect(
      meterEventSpendUsdMicros(costEvent("01J0000000000000000000EV03", ENVIRONMENTS[0]!, {})),
    ).toBe(0);
  });

  test("advances organization, project, and environment spend once per event", async () => {
    const { database, records } = makeTenancyTestDatabase();
    await database.transactWrite([
      {
        kind: "put",
        record: Schema.decodeUnknownSync(BudgetRecord)(
          withCanonicalRecordKeys({
            data: {
              amountUsdMicros: 1_000,
              createdAt: "2026-07-01T00:00:00.000Z",
              id: "01J000000000000000000BDG01",
              name: "Org",
              organizationId: ORGANIZATION_ID,
              period: "monthly",
              scope: "organization",
              status: "active",
              thresholds: [80],
              updatedAt: "2026-07-01T00:00:00.000Z",
              version: 1,
            },
            itemType: "budget" as const,
          }),
        ),
      },
    ]);
    const first = costEvent("01J0000000000000000000EV04", ENVIRONMENTS[0]!, {
      costUsdMicros: 600,
    });
    const result = await materializeMeterEvent(database, first);
    expect(result.spendShards.map((shard) => [shard.data.scope, shard.data.period])).toHaveLength(
      12,
    );
    expect(new Set(result.spendShards.map((shard) => shard.data.spendUsdMicros))).toEqual(
      new Set([600]),
    );
    expect((await materializeMeterEvent(database, first)).spendShards).toEqual([]);
    expect(
      await findExhaustedBudget(
        database,
        {
          environmentId: ENVIRONMENTS[1]!,
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
          workspaceId: undefined,
        },
        new Date("2026-07-31T00:00:00.000Z"),
      ),
    ).toBeUndefined();

    await materializeMeterEvent(
      database,
      costEvent("01J0000000000000000000EV05", ENVIRONMENTS[1]!, { costUsdMicros: 400 }),
    );
    expect(
      (
        await findExhaustedBudget(
          database,
          {
            environmentId: ENVIRONMENTS[1]!,
            organizationId: ORGANIZATION_ID,
            projectId: PROJECT_ID,
            workspaceId: undefined,
          },
          new Date("2026-07-31T00:00:00.000Z"),
        )
      )?.spendUsdMicros,
    ).toBe(1_000);

    const shardVersions = () =>
      [...records.values()].flatMap((record) =>
        record.itemType === "scope-spend-shard" ? [`${record.sk}@${record.data.version}`] : [],
      );
    const before = shardVersions();
    const free = await materializeMeterEvent(
      database,
      costEvent("01J0000000000000000000EV06", ENVIRONMENTS[1]!, {}),
    );
    expect(free.spendShards).toEqual([]);
    expect(shardVersions()).toEqual(before);
  });

  test("adds a workspace event's spend to its workspace and every ancestor, not its sibling", async () => {
    const { database, records } = makeTenancyTestDatabase();
    const environmentId = ENVIRONMENTS[0]!;
    const result = await materializeMeterEvent(
      database,
      costEvent(
        "01J0000000000000000000EV15",
        environmentId,
        { costUsdMicros: 700 },
        { workspaceId: WORKSPACE_ID },
      ),
    );
    expect(result.spendShards).toHaveLength(16);
    const monthSpend = (target: Parameters<typeof readMonthSpend>[2]) =>
      readMonthSpend(database, ORGANIZATION_ID, target, new Date("2026-07-31T00:00:00.000Z")).then(
        (spend) => spend.totalUsdMicros,
      );
    const workspace = { environmentId, projectId: PROJECT_ID, workspaceId: WORKSPACE_ID };
    expect(
      await Promise.all([
        monthSpend({ ...workspace, scope: "workspace" }),
        monthSpend({ environmentId, projectId: PROJECT_ID, scope: "environment" }),
        monthSpend({ projectId: PROJECT_ID, scope: "project" }),
        monthSpend({ scope: "organization" }),
        monthSpend({ ...workspace, scope: "workspace", workspaceId: OTHER_WORKSPACE_ID }),
      ]),
    ).toEqual([700, 700, 700, 700, 0]);

    const workspaceShards = () =>
      [...records.values()].filter(
        (record) => record.itemType === "scope-spend-shard" && record.data.scope === "workspace",
      );
    expect(workspaceShards()).toHaveLength(4);
    await materializeMeterEvent(
      database,
      costEvent("01J0000000000000000000EV16", environmentId, { costUsdMicros: 300 }),
    );
    expect(workspaceShards()).toHaveLength(4);
    expect(await monthSpend({ ...workspace, scope: "workspace" })).toBe(700);
    expect(await monthSpend({ scope: "organization" })).toBe(1_000);
  });

  test("adds every event to total spend and organization-funded events to their own total, once", async () => {
    const { database, records } = makeTenancyTestDatabase();
    const organizationFunded = costEvent("01J0000000000000000000EV10", ENVIRONMENTS[1]!, {
      costUsdMicros: 400,
      funding: "organization",
      modelCredentialId: "01J0000000000000000000CRED",
    });
    await materializeMeterEvent(
      database,
      costEvent("01J0000000000000000000EV08", ENVIRONMENTS[0]!, {
        costUsdMicros: 600,
        funding: "operator",
      }),
    );
    await materializeMeterEvent(
      database,
      costEvent("01J0000000000000000000EV09", ENVIRONMENTS[1]!, { costUsdMicros: 250 }),
    );
    await materializeMeterEvent(database, organizationFunded);
    const shardVersions = () =>
      [...records.values()].flatMap((record) =>
        record.itemType === "scope-spend-shard" ? [`${record.sk}@${record.data.version}`] : [],
      );
    const versionsBeforeRedelivery = shardVersions();

    expect((await materializeMeterEvent(database, organizationFunded)).duplicate).toBe(true);
    expect(shardVersions()).toEqual(versionsBeforeRedelivery);
    expect(
      await readMonthSpend(
        database,
        ORGANIZATION_ID,
        { scope: "organization" },
        new Date("2026-07-31T00:00:00.000Z"),
      ),
    ).toEqual({
      asOf: "2026-07-31T00:00:00.000Z",
      operatorFundedUsdMicros: 850,
      organizationFundedUsdMicros: 400,
      periodStart: "2026-07-01T00:00:00.000Z",
      totalUsdMicros: 1_250,
    });
  });

  test.each([
    { funding: "organization" },
    { funding: "operator", modelCredentialId: "01J0000000000000000000CRED" },
    { funding: "customer" },
  ])("rejects meter event funding %j", (dimensions) => {
    expect(() => costEvent("01J0000000000000000000EV11", ENVIRONMENTS[0]!, dimensions)).toThrow(
      "Meter event funding must be operator, or organization with its model credential id.",
    );
  });

  test("rejects a meter event whose run context names another workspace", () => {
    expect(() =>
      costEvent(
        "01J0000000000000000000EV12",
        ENVIRONMENTS[0]!,
        {},
        { observabilityWorkspaceId: WORKSPACE_ID, workspaceId: OTHER_WORKSPACE_ID },
      ),
    ).toThrow("A run's meter event must name the run's workspace.");
    expect(() =>
      costEvent(
        "01J0000000000000000000EV13",
        ENVIRONMENTS[0]!,
        {},
        { observabilityWorkspaceId: WORKSPACE_ID },
      ),
    ).toThrow("A run's meter event must name the run's workspace.");
  });

  test.each([
    [
      "the run's own workspace",
      { observabilityWorkspaceId: WORKSPACE_ID, workspaceId: WORKSPACE_ID },
    ],
    ["a workspace without run context", { workspaceId: WORKSPACE_ID }],
    ["a run outside any workspace", { observabilityWorkspaceId: undefined }],
    ["no workspace", {}],
  ] as const)("accepts a meter event attributed to %s", (_case, attribution) => {
    expect(
      costEvent("01J0000000000000000000EV14", ENVIRONMENTS[0]!, {}, attribution).data.workspaceId,
    ).toBe("workspaceId" in attribution ? attribution.workspaceId : undefined);
  });

  test("keeps the widest cost transaction, a workspace agent's, within DynamoDB limits after companions", async () => {
    const memory = makeTenancyTestDatabase();
    const transactions: TransactionOperation[][] = [];
    const database = {
      ...memory.database,
      transactWrite: (operations: readonly TransactionOperation[]) => {
        transactions.push([...operations]);
        return memory.database.transactWrite(operations);
      },
    };
    await materializeMeterEvent(
      database,
      costEvent(
        "01J0000000000000000000EV07",
        ENVIRONMENTS[0]!,
        { costUsdMicros: 5, costUsdNanoDollars: 4_600 },
        { workspaceId: WORKSPACE_ID },
      ),
      { agentDefinitionId: "01J00000000000000000000AGT" },
    );

    expect(transactions).toHaveLength(1);
    const prepared = await prepareDynamoTransactionOperations(transactions[0]!);
    expect(prepared).toHaveLength(58);
  });
});
