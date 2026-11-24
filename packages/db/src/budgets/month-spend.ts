import { Option, Schema } from "effect";
import type { DynamoDatabaseService } from "../client-types.ts";
import type { Ulid } from "../ids.ts";
import { key } from "../keys.ts";
import { SpendMonth } from "../records/usage.ts";
import type { ScopeTarget } from "../usage-scope.ts";
import { budgetPeriodBounds } from "./periods.ts";
import { readScopeSpend } from "./spend.ts";

const decodeSpendMonth = Schema.decodeUnknownOption(SpendMonth);

/** The UTC month containing `at`. */
export function spendMonthOf(at: Date | string): SpendMonth {
  return Option.getOrThrow(
    decodeSpendMonth(budgetPeriodBounds("monthly", at).periodStart.slice(0, 7)),
  );
}

/**
 * The month a spend read asks for: `requested` as `YYYY-MM`, or the month containing `now` when
 * absent. None when `requested` is malformed or later than the month containing `now`.
 */
export function requestedSpendMonth(
  requested: string | undefined,
  now: Date,
): Option.Option<SpendMonth> {
  const current = spendMonthOf(now);
  if (requested === undefined) return Option.some(current);
  return decodeSpendMonth(requested).pipe(Option.filter((month) => month <= current));
}

/** One scope's spend in one UTC calendar month, split by who paid. */
export interface MonthSpend {
  readonly asOf: string;
  readonly operatorFundedUsdMicros: number;
  readonly organizationFundedUsdMicros: number;
  readonly periodStart: string;
  readonly totalUsdMicros: number;
}

/**
 * Spend of one scope of an organization in `month` (the month containing `asOf` when omitted) as
 * of `asOf`: one strongly consistent read of its 16 shards.
 */
export async function readMonthSpend(
  database: DynamoDatabaseService,
  organizationId: Ulid,
  target: ScopeTarget,
  asOf: Date,
  month: SpendMonth = spendMonthOf(asOf),
): Promise<MonthSpend> {
  const periodStart = `${month}-01T00:00:00.000Z`;
  const { organizationFundedUsdMicros, totalUsdMicros } = await readScopeSpend(
    database,
    organizationId,
    target,
    "monthly",
    periodStart,
  );
  return {
    asOf: asOf.toISOString(),
    operatorFundedUsdMicros: totalUsdMicros - organizationFundedUsdMicros,
    organizationFundedUsdMicros,
    periodStart,
    totalUsdMicros,
  };
}

/** One project's spend in a UTC month; archived projects stay listed so past months still add up. */
export interface ProjectMonthSpend extends Omit<MonthSpend, "asOf" | "periodStart"> {
  readonly projectId: Ulid;
}

const PROJECT_READS_IN_FLIGHT = 8;

/**
 * Every project of the organization with its spend in `month`, as of `asOf`: a strongly
 * consistent listing of the organization's project records, then one bounded shard read per
 * project, at most eight at once.
 */
export async function readProjectMonthSpend(
  database: DynamoDatabaseService,
  organizationId: Ulid,
  asOf: Date,
  month: SpendMonth,
): Promise<readonly ProjectMonthSpend[]> {
  const projectIds: Ulid[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await database.queryRecords("control", {
      ConsistentRead: true,
      ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      ExpressionAttributeNames: { "#partition": "pk", "#sort": "sk" },
      ExpressionAttributeValues: {
        ":partition": key("ORG", organizationId),
        ":prefix": "PROJECT#",
      },
      KeyConditionExpression: "#partition = :partition AND begins_with(#sort, :prefix)",
      Limit: 100,
    });
    for (const item of page.items) {
      if (item.itemType === "project" && item.data.organizationId === organizationId) {
        projectIds.push(item.data.id);
      }
    }
    exclusiveStartKey = page.lastEvaluatedKey;
  } while (exclusiveStartKey);
  const spends: ProjectMonthSpend[] = [];
  for (let start = 0; start < projectIds.length; start += PROJECT_READS_IN_FLIGHT) {
    spends.push(
      ...(await Promise.all(
        projectIds.slice(start, start + PROJECT_READS_IN_FLIGHT).map(async (projectId) => {
          const {
            asOf: _asOf,
            periodStart: _periodStart,
            ...spend
          } = await readMonthSpend(
            database,
            organizationId,
            { projectId, scope: "project" },
            asOf,
            month,
          );
          return { ...spend, projectId };
        }),
      )),
    );
  }
  return spends;
}
