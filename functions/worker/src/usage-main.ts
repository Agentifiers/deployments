import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import {
  decodePlatformRecord,
  evaluateBudgetThresholds,
  makeDynamoDatabase,
  makeOrganizationStandingRepository,
  meterEventFunding,
  recordOperatorFundedSpendExhaustion,
  spendMonthOf,
  tableNamesFromEnvironment,
  usageScopeOf,
  type OrganizationStandingRepository,
} from "@deployments-ai/db";
import { parseInstallDefaultEntitlements } from "@deployments-ai/tenant-limits/install-defaults";
import { materializeMeterEvent, meterEventSpendUsdMicros } from "@deployments-ai/usage";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { Effect } from "effect";
import { repairTraceFinalizationForRunId } from "./trace-finalization.ts";
import { createMeterEventAgentResolver } from "./usage-agent-attribution.ts";

export interface MeterEventStreamRecord {
  readonly dynamodb?: {
    readonly NewImage?: Record<string, AttributeValue>;
    readonly SequenceNumber?: string;
  };
  readonly eventID?: string;
  readonly eventName?: string;
}

export function meterEventStreamFailureIdentifier(record: MeterEventStreamRecord) {
  const sequenceNumber = record.dynamodb?.SequenceNumber?.trim();
  if (!sequenceNumber) {
    throw new Error("Meter event stream record failed without a DynamoDB sequence number.");
  }
  return sequenceNumber;
}

export interface MeterEventStreamEvent {
  readonly Records?: readonly MeterEventStreamRecord[];
}

interface TraceRepairGroup {
  readonly event: Parameters<typeof repairTraceFinalizationForRunId>[1];
  readonly itemIdentifiers: Set<string>;
}

const TRACE_REPAIR_CONCURRENCY = 4;

let database = makeDynamoDatabase(
  DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  }),
  tableNamesFromEnvironment(),
);
let meterEventAgent = createMeterEventAgentResolver(database);
let installEnvironment: Readonly<Record<string, string | undefined>> = process.env;
let standing: OrganizationStandingRepository | undefined;

function organizationStanding() {
  standing ??= makeOrganizationStandingRepository({
    database,
    installDefaults: parseInstallDefaultEntitlements(installEnvironment),
  });
  return standing;
}

export function setUsageMaterializerDatabaseForTest(
  value: typeof database,
  environment: Readonly<Record<string, string | undefined>>,
) {
  database = value;
  meterEventAgent = createMeterEventAgentResolver(value);
  installEnvironment = environment;
  standing = undefined;
}

export async function handler(event: MeterEventStreamEvent) {
  const failures = new Set<string>();
  const traceRepairs = new Map<string, TraceRepairGroup>();
  for (const record of event.Records ?? []) {
    if (record.eventName !== "INSERT" || !record.dynamodb?.NewImage) continue;
    try {
      const decoded = await Effect.runPromise(
        decodePlatformRecord(unmarshall(record.dynamodb.NewImage)),
      );
      if (decoded.itemType !== "meter-event") continue;
      const agentDefinitionId = await meterEventAgent(decoded);
      await materializeMeterEvent(
        database,
        decoded,
        agentDefinitionId ? { agentDefinitionId } : {},
      );
      // Also re-run for duplicates: a retry after a failed evaluation must still emit its alerts.
      if (meterEventSpendUsdMicros(decoded) > 0) {
        await evaluateBudgetThresholds(database, {
          occurredAt: decoded.data.occurredAt,
          scope: usageScopeOf(decoded.data),
        });
        if (meterEventFunding(decoded.data.dimensions) === "operator") {
          const { entitlements } = await organizationStanding().read(decoded.data.organizationId, {
            consistent: true,
          });
          await recordOperatorFundedSpendExhaustion(database, {
            ceiling: entitlements.operatorFundedModelSpendCeiling,
            month: spendMonthOf(decoded.data.occurredAt),
            organizationId: decoded.data.organizationId,
          });
        }
      }
      if (
        decoded.data.metric === "model_tokens" &&
        decoded.data.unit === "tokens" &&
        decoded.data.runId !== undefined &&
        decoded.data.observability !== undefined
      ) {
        const repairEvent = {
          environmentId: decoded.data.environmentId,
          organizationId: decoded.data.organizationId,
          projectId: decoded.data.projectId,
          runId: decoded.data.runId,
        };
        const repairKey = [
          repairEvent.organizationId,
          repairEvent.projectId,
          repairEvent.environmentId,
          decoded.data.observability.traceId,
        ].join(":");
        const group = traceRepairs.get(repairKey) ?? {
          event: repairEvent,
          itemIdentifiers: new Set<string>(),
        };
        group.itemIdentifiers.add(meterEventStreamFailureIdentifier(record));
        traceRepairs.set(repairKey, group);
      }
    } catch {
      failures.add(meterEventStreamFailureIdentifier(record));
    }
  }
  const repairs = [...traceRepairs.values()];
  for (let offset = 0; offset < repairs.length; offset += TRACE_REPAIR_CONCURRENCY) {
    await Promise.all(
      repairs.slice(offset, offset + TRACE_REPAIR_CONCURRENCY).map(async (repair) => {
        try {
          await repairTraceFinalizationForRunId(database, repair.event, {
            allowMissingRun: true,
          });
        } catch {
          for (const itemIdentifier of repair.itemIdentifiers) failures.add(itemIdentifier);
        }
      }),
    );
  }
  return {
    batchItemFailures: [...failures].map((itemIdentifier) => ({ itemIdentifier })),
  };
}
