import { Schema } from "effect";
import type { DynamoDatabaseService, TransactionOperation } from "../client-types.ts";
import { Ulid } from "../ids.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { RateLimitCounterRecord } from "../records/usage.ts";
import { isDatabaseWriteConflict } from "../transaction-conditions.ts";

/** Certificate requests one UTC day admits for each organization and for the whole platform. */
export interface CertificateRequestLimits {
  readonly organization: number;
  readonly platform: number;
}

export type CertificateRequestGrant = "granted" | "organization-spent" | "platform-spent";

type Counter = typeof RateLimitCounterRecord.Type;

const LIMIT_KEY = "app-domain.certificate-request";
/** No organization or resource has the zero ULID, so the platform counter has a scope of its own. */
const PLATFORM_SCOPE = Schema.decodeUnknownSync(Ulid)("00000000000000000000000000");
const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_RACES = 3;

const decodeCounter = Schema.decodeUnknownSync(RateLimitCounterRecord);

function emptyCounter(scope: { readonly organizationId?: Ulid; readonly scopeId: Ulid }, at: Date) {
  const window = at.toISOString().slice(0, 10);
  const expiresAt = new Date(Date.parse(`${window}T00:00:00.000Z`) + DAY_MS).toISOString();
  return decodeCounter(
    withCanonicalRecordKeys({
      data: { ...scope, count: 0, expiresAt, limitKey: LIMIT_KEY, version: 0, window },
      itemType: "rate-limit-counter" as const,
      ttl: Math.floor(Date.parse(expiresAt) / 1_000),
    }),
  );
}

function takeOne(empty: Counter, stored: Counter | undefined): TransactionOperation {
  if (!stored) return { kind: "put", record: { ...empty, data: { ...empty.data, count: 1 } } };
  return {
    kind: "put",
    previousRecord: stored,
    record: {
      ...stored,
      data: { ...stored.data, count: stored.data.count + 1, version: stored.data.version + 1 },
    },
  };
}

/**
 * Takes one unit from the organization's and the platform's budget for the current UTC day in one
 * transaction. Each put is conditioned on the version it read, so no count passes its limit.
 */
export async function takeCertificateRequest(
  dependencies: { readonly database: DynamoDatabaseService; readonly now: () => Date },
  input: { readonly limits: CertificateRequestLimits; readonly organizationId: Ulid },
): Promise<CertificateRequestGrant> {
  const { database, now } = dependencies;
  const { limits, organizationId } = input;
  for (let race = 0; ; race += 1) {
    const at = now();
    const budgets = [
      {
        empty: emptyCounter({ organizationId, scopeId: organizationId }, at),
        limit: limits.organization,
        spent: "organization-spent",
      },
      {
        empty: emptyCounter({ scopeId: PLATFORM_SCOPE }, at),
        limit: limits.platform,
        spent: "platform-spent",
      },
    ] as const;
    const stored = await Promise.all(
      budgets.map(async ({ empty }) => {
        const record = await database.getRecord("usage", { pk: empty.pk, sk: empty.sk }, true);
        if (record && record.itemType !== "rate-limit-counter") {
          throw new Error(`${empty.pk}/${empty.sk} is not a certificate request counter.`);
        }
        return record;
      }),
    );
    const spent = budgets.find(({ limit }, index) => (stored[index]?.data.count ?? 0) >= limit);
    if (spent) return spent.spent;
    try {
      await database.transactWrite(
        budgets.map(({ empty }, index) => takeOne(empty, stored[index])),
      );
      return "granted";
    } catch (cause) {
      if (race >= MAX_RACES || !isDatabaseWriteConflict(cause)) throw cause;
    }
  }
}
