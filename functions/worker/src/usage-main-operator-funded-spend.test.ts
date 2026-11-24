import { marshall } from "@aws-sdk/util-dynamodb";
import {
  makeOrganizationStandingRepository,
  MeterEventRecord,
  OrganizationRecord,
  StandingActor,
  withCanonicalRecordKeys,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import { makeTenancyTestDatabase } from "@deployments-ai/db/memory-testing";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { id } from "./agent-run.fixture.ts";
import { handler, setUsageMaterializerDatabaseForTest } from "./usage-main.ts";

const TENANT_LIMIT_DEFAULTS = {
  active_sandboxes: 8,
  api_request_burst: 40,
  api_requests_per_second: 20,
  concurrent_runs: 8,
};
const INSTALL_ENVIRONMENT = {
  DEPLOYMENTS_AI_OPERATOR_FUNDED_MODEL_SPEND_CEILING_USD_MICROS: "1000",
  DEPLOYMENTS_AI_TENANT_LIMIT_DEFAULTS: JSON.stringify(TENANT_LIMIT_DEFAULTS),
};
const DEFAULTED = id(61);
const UNLIMITED = id(62);

let sequence = 0;

function cost(
  organizationId: Ulid,
  costUsdMicros: number,
  funding: "operator" | "organization" = "operator",
) {
  sequence += 1;
  return Schema.decodeUnknownSync(MeterEventRecord)(
    withCanonicalRecordKeys({
      data: {
        dimensions: {
          costUsdMicros,
          ...(funding === "organization"
            ? { funding, modelCredentialId: "01J00000000000000000000KEY" }
            : { funding }),
        },
        environmentId: id(63),
        id: id(100 + sequence),
        idempotencyKey: `cost-${sequence}`,
        metric: "model_tokens",
        occurredAt: "2026-07-23T12:00:00.000Z",
        organizationId,
        projectId: id(64),
        quantity: 10,
        source: "model-gateway",
        unit: "tokens",
      },
      itemType: "meter-event" as const,
    }),
  );
}

function delivery(...events: readonly PlatformRecord[]) {
  return {
    Records: events.map((event, index) => ({
      dynamodb: {
        NewImage: marshall(event, { removeUndefinedValues: true }),
        SequenceNumber: String(323456790 + sequence * 10 + index),
      },
      eventName: "INSERT",
    })),
  };
}

function organization(organizationId: Ulid) {
  return Schema.decodeUnknownSync(OrganizationRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: "2026-07-01T00:00:00.000Z",
        id: organizationId,
        name: organizationId,
        slug: `org-${organizationId.slice(-4).toLowerCase()}`,
        status: "active",
        updatedAt: "2026-07-01T00:00:00.000Z",
        version: 1,
      },
      itemType: "organization" as const,
    }),
  );
}

describe("operator-funded spend exhaustion in the usage materializer", () => {
  test("emits once per organization and month when operator-funded spend reaches the effective ceiling", async () => {
    const { database, records } = makeTenancyTestDatabase();
    await database.transactWrite(
      [organization(DEFAULTED), organization(UNLIMITED)].map((record) => ({
        kind: "put" as const,
        record,
      })),
    );
    await makeOrganizationStandingRepository({
      database,
      installDefaults: {
        operatorFundedModelSpendCeiling: { monthlyUsdMicros: 1_000 },
        tenantLimits: {
          activeSandboxes: 8,
          apiRequestBurst: 40,
          apiRequestsPerSecond: 20,
          concurrentRuns: 8,
        },
      },
    }).setGrant({
      actor: Schema.decodeUnknownSync(StandingActor)({ kind: "operator", principalId: id(65) }),
      entitlements: { operatorFundedModelSpendCeiling: "unlimited" },
      organizationId: UNLIMITED,
    });
    setUsageMaterializerDatabaseForTest(database, INSTALL_ENVIRONMENT);
    const crossing = cost(DEFAULTED, 500);

    const failures = [
      await handler(delivery(cost(DEFAULTED, 5_000, "organization"), cost(DEFAULTED, 600))),
      await handler(delivery(crossing)),
      await handler(delivery(cost(DEFAULTED, 300), crossing)),
      await handler(delivery(cost(UNLIMITED, 9_000))),
    ].flatMap((result) => result.batchItemFailures);

    expect(failures).toEqual([]);
    expect(
      [...records.values()].flatMap((record) =>
        record.itemType === "semantic-event" &&
        record.data.eventType === "organization.operator-funded-spend-exhausted"
          ? [record.data.payload]
          : [],
      ),
    ).toEqual([
      {
        ceilingUsdMicros: 1_000,
        month: "2026-07",
        operatorFundedUsdMicros: 1_100,
        organizationId: DEFAULTED,
      },
    ]);
  });
});
