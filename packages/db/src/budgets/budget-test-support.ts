import { Schema } from "effect";
import type { DynamoDatabaseService, TransactionOperation } from "../client-types.ts";
import type { Ulid } from "../ids.ts";
import type { PlatformRecord } from "../records/index.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { BudgetRecord, type SpendFunding } from "../records/usage.ts";
import { scopeChain, type ScopeLevel, type UsageScope } from "../usage-scope.ts";
import { addScopeSpend, scopeSpendShardCandidates } from "./spend.ts";

export const ORGANIZATION_ID = "01J000000000000000000000RG" as Ulid;
export const PROJECT_ID = "01J00000000000000000000PRJ" as Ulid;
export const ENVIRONMENT_ID = "01J00000000000000000000ENV" as Ulid;
export const OTHER_ENVIRONMENT_ID = "01J00000000000000000000EN2" as Ulid;
export const WORKSPACE_ID = "01J00000000000000000000WS1" as Ulid;
export const OTHER_WORKSPACE_ID = "01J00000000000000000000WS2" as Ulid;

export const RUN_SCOPE: UsageScope = {
  environmentId: ENVIRONMENT_ID,
  organizationId: ORGANIZATION_ID,
  projectId: PROJECT_ID,
  workspaceId: undefined,
};

export const WORKSPACE_RUN_SCOPE: UsageScope = { ...RUN_SCOPE, workspaceId: WORKSPACE_ID };

let sequence = 0;

/** Monotonic, schema-valid ULIDs for deterministic tests. */
export async function testId(): Promise<Ulid> {
  sequence += 1;
  return `01J0000000000000000${String(sequence).padStart(7, "0")}` as Ulid;
}

/** A decoded budget; overrides are validated by the schema rather than the type system. */
export function budgetRecord(
  overrides: Readonly<Record<string, unknown>> & {
    readonly scope: ScopeLevel;
  },
) {
  const { scope: _scope, ...scopeFields } =
    scopeChain(WORKSPACE_RUN_SCOPE).find((target) => target.scope === overrides.scope) ?? {};
  return Schema.decodeUnknownSync(BudgetRecord)(
    withCanonicalRecordKeys({
      data: {
        amountUsdMicros: 1_000_000,
        createdAt: "2026-01-01T00:00:00.000Z",
        id: "01J000000000000000000BDG01",
        name: "Budget",
        organizationId: ORGANIZATION_ID,
        period: "monthly",
        status: "active",
        thresholds: [50, 80, 100],
        updatedAt: "2026-01-01T00:00:00.000Z",
        version: 1,
        ...scopeFields,
        ...overrides,
      },
      itemType: "budget" as const,
    }),
  );
}

/** Seeds budgets directly, bypassing the create limits and events. */
export async function seed(database: DynamoDatabaseService, records: readonly PlatformRecord[]) {
  await database.transactWrite(
    records.map((record): TransactionOperation => ({ kind: "put", record })),
  );
}

/**
 * Records spend the way the usage materializer does: every shard of the scope's chain for
 * every period kind, advanced from its stored version.
 */
export async function recordSpend(
  database: DynamoDatabaseService,
  input: {
    readonly funding?: SpendFunding;
    readonly occurredAt: string;
    readonly scope?: UsageScope;
    readonly shard?: number;
    readonly spendUsdMicros: number;
  },
) {
  const candidates = scopeSpendShardCandidates({
    occurredAt: input.occurredAt,
    scope: input.scope ?? RUN_SCOPE,
    shard: input.shard ?? 0,
    updatedAt: input.occurredAt,
  });
  const previous = await Promise.all(
    candidates.map(async (candidate) => {
      const stored = await database.getRecord(
        "usage",
        { pk: candidate.pk, sk: candidate.sk },
        true,
      );
      return stored?.itemType === "scope-spend-shard" ? stored : undefined;
    }),
  );
  await database.transactWrite(
    candidates.map(
      (candidate, index): TransactionOperation => ({
        kind: "put",
        ...(previous[index] ? { previousRecord: previous[index] } : {}),
        record: addScopeSpend(
          candidate,
          previous[index],
          input.spendUsdMicros,
          input.funding ?? "operator",
        ),
      }),
    ),
  );
}
