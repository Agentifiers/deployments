import type { OperatorModelSpend } from "@deployments-ai/model-gateway";
import { Schema } from "effect";
import { readMonthSpend } from "../budgets/month-spend.ts";
import type { DynamoDatabaseService } from "../client-types.ts";
import { makeIdGenerator, Ulid } from "../ids.ts";
import { Keys } from "../keys.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import {
  OperatorFundedSpendExhaustionRecord,
  type ModelSpendCeiling,
} from "../records/organization-standing.ts";
import type { SpendMonth } from "../records/usage.ts";
import { makeSemanticEventRecord, transactWithSemanticEvents } from "../semantic-event-storage.ts";
import { isDatabaseWriteConflict } from "../transaction-conditions.ts";
import { effectiveModelSpendCeiling } from "./effective-standing.ts";

export const OPERATOR_FUNDED_SPEND_EXHAUSTED_EVENT = "organization.operator-funded-spend-exhausted";

const MAX_CONFLICT_RETRIES = 8;
const decodeUlid = Schema.decodeUnknownSync(Ulid);

/**
 * The organization's operator-funded model spend in the UTC month of `asOf` against its effective
 * ceiling: a strongly consistent read of its standing, then, only when the ceiling is finite, a
 * strongly consistent read of its spend shards.
 */
export async function readOperatorFundedModelSpend(
  database: DynamoDatabaseService,
  organizationId: string,
  input: { readonly asOf: Date; readonly defaultCeiling: ModelSpendCeiling },
): Promise<OperatorModelSpend> {
  const organization = decodeUlid(organizationId);
  const stored = await database.getRecord(
    "control",
    Keys.control.organizationStanding(organization),
    true,
  );
  const ceiling = effectiveModelSpendCeiling(
    stored?.itemType === "organization-standing" ? stored.data : undefined,
    input.defaultCeiling,
  );
  if (ceiling === "unlimited") return { kind: "unlimited" };
  const spend = await readMonthSpend(database, organization, { scope: "organization" }, input.asOf);
  return {
    ceilingUsdMicros: ceiling.monthlyUsdMicros,
    kind: "metered",
    spentUsdMicros: spend.operatorFundedUsdMicros,
  };
}

export interface OperatorFundedSpendExhaustion {
  readonly ceilingUsdMicros: number;
  readonly eventId: Ulid;
  readonly month: SpendMonth;
  readonly operatorFundedUsdMicros: number;
  readonly organizationId: Ulid;
}

/**
 * Emits `organization.operator-funded-spend-exhausted` the first time the organization's
 * operator-funded spend in `month` reaches a finite `ceiling`. A create-only claim per organization
 * and month is written in the event's transaction, so concurrent and repeated evaluations emit it
 * at most once, and a rerun after any failure emits it if it is still owed.
 */
export async function recordOperatorFundedSpendExhaustion(
  database: DynamoDatabaseService,
  input: {
    readonly ceiling: ModelSpendCeiling;
    readonly month: SpendMonth;
    readonly organizationId: Ulid;
  },
  options: { readonly generateId?: () => Promise<Ulid>; readonly now?: () => Date } = {},
): Promise<OperatorFundedSpendExhaustion | undefined> {
  const { ceiling, month, organizationId } = input;
  if (ceiling === "unlimited") return undefined;
  const ids = makeIdGenerator();
  const generateId = options.generateId ?? (async () => ids.generate());
  const now = options.now ?? (() => new Date());
  for (let conflicts = 0; ; conflicts += 1) {
    const claimed = await database.getRecord(
      "control",
      Keys.control.operatorFundedSpendExhaustion(organizationId, month),
      true,
    );
    if (claimed) return undefined;
    const { operatorFundedUsdMicros } = await readMonthSpend(
      database,
      organizationId,
      { scope: "organization" },
      now(),
      month,
    );
    if (operatorFundedUsdMicros < ceiling.monthlyUsdMicros) return undefined;
    const exhaustedAt = now().toISOString();
    const [id, eventId] = await Promise.all([generateId(), generateId()]);
    const exhaustion = {
      ceilingUsdMicros: ceiling.monthlyUsdMicros,
      month,
      operatorFundedUsdMicros,
      organizationId,
    };
    const claim = Schema.decodeUnknownSync(OperatorFundedSpendExhaustionRecord)(
      withCanonicalRecordKeys({
        data: { ...exhaustion, exhaustedAt, id },
        itemType: "operator-funded-spend-exhaustion" as const,
      }),
    );
    const event = makeSemanticEventRecord({
      actor: { type: "system" },
      aggregateId: id,
      aggregateType: "operator-funded-spend-exhaustion",
      aggregateVersion: 1,
      eventId,
      eventType: OPERATOR_FUNDED_SPEND_EXHAUSTED_EVENT,
      occurredAt: exhaustedAt,
      organizationId,
      payload: exhaustion,
    });
    try {
      await transactWithSemanticEvents(database, [{ kind: "put", record: claim }], [event]);
      return { ...exhaustion, eventId };
    } catch (cause) {
      if (!isDatabaseWriteConflict(cause) || conflicts + 1 >= MAX_CONFLICT_RETRIES) throw cause;
    }
  }
}
