import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { makeDynamoDatabase } from "../client.ts";
import { Ulid } from "../ids.ts";
import {
  fakeDynamoDocumentClient,
  transactionCanceledError,
} from "../testing/dynamo-document-client.fixture.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { makeOAuthRefreshClaimPersistence, oauthRefreshClaimKey } from "./oauth-refresh-claims.ts";

const [organizationId, projectId, environmentId, connectionId] = Array.from(
  { length: 4 },
  (_, index) =>
    Schema.decodeUnknownSync(Ulid)(`01ARZ3NDEKTSV4RRFFQ69G5F${String(index).padStart(2, "0")}`),
) as [Ulid, Ulid, Ulid, Ulid];
const target = { connectionId, credentialGeneration: 3, environmentId, organizationId, projectId };
const now = new Date("2026-09-30T00:00:00.000Z");
const leaseMs = 60_000;
const later = (ms: number) => new Date(now.getTime() + ms);

function seeded() {
  const dynamo = fakeDynamoDocumentClient();
  dynamo.put(
    "control",
    withCanonicalRecordKeys({
      data: {
        createdAt: "2026-09-01T00:00:00.000Z",
        id: organizationId,
        name: "Refresh Organization",
        slug: "refresh-organization",
        status: "active",
        updatedAt: "2026-09-01T00:00:00.000Z",
        version: 1,
      },
      itemType: "organization",
    }),
  );
  const persistence = makeOAuthRefreshClaimPersistence(makeDynamoDatabase(dynamo.client));
  const stored = () => dynamo.get("execution", oauthRefreshClaimKey(target));
  const acquire = (owner: string, at = now) =>
    persistence.acquire({ ...target, leaseMs, now: at, owner });
  const release = (owner: string) => persistence.release({ ...target, owner });
  return { acquire, dynamo, release, stored };
}

describe("oauth refresh claims", () => {
  test("creates a generation-keyed claim whose TTL follows its lease", async () => {
    const { acquire, stored } = seeded();

    expect(await acquire("worker-a")).toBe("acquired");
    const item = stored();
    const expiresAt = later(leaseMs).toISOString();
    expect(item).toMatchObject({
      data: { credentialGeneration: 3, expiresAt, owner: "worker-a", version: 0 },
      pk: `ORG#${organizationId}#ENV#${environmentId}`,
      sk: `OAUTH-REFRESH-CLAIM#${connectionId}#3`,
      ttl: Math.floor(Date.parse(expiresAt) / 1_000),
    });
  });

  test("reports a live claim held by another owner without writing", async () => {
    const { acquire, dynamo, stored } = seeded();
    await acquire("worker-a");
    const writes = dynamo.transactions.length;

    expect(await acquire("worker-b", later(leaseMs - 1))).toBe("held");
    expect(dynamo.transactions).toHaveLength(writes);
    expect(stored()?.data).toMatchObject({ owner: "worker-a" });
  });

  test("takes over a logically expired claim with a versioned replacement", async () => {
    const { acquire, stored } = seeded();
    await acquire("worker-a");

    expect(await acquire("worker-b", later(leaseMs))).toBe("acquired");
    expect(stored()?.data).toMatchObject({
      createdAt: now.toISOString(),
      expiresAt: later(2 * leaseMs).toISOString(),
      owner: "worker-b",
      version: 1,
    });
  });

  test("lets exactly one concurrent refresher win the same generation", async () => {
    const { acquire } = seeded();

    const outcomes = await Promise.all([acquire("worker-a"), acquire("worker-b")]);
    expect(outcomes.toSorted()).toEqual(["acquired", "held"]);
  });

  test("maps a conditional failure during takeover to held", async () => {
    const { acquire, dynamo, stored } = seeded();
    await acquire("worker-a");
    dynamo.failNextTransaction(
      () => true,
      () => transactionCanceledError(["ConditionalCheckFailed"]),
    );

    expect(await acquire("worker-b", later(leaseMs))).toBe("held");
    expect(stored()?.data).toMatchObject({ owner: "worker-a", version: 0 });
  });

  test("releases only the caller's own claim and ignores a missing claim", async () => {
    const { acquire, release, stored } = seeded();
    await release("worker-a");
    await acquire("worker-a");

    await release("worker-b");
    expect(stored()?.data).toMatchObject({ owner: "worker-a" });
    await release("worker-a");
    expect(stored()).toBeUndefined();
    expect(await acquire("worker-b")).toBe("acquired");
  });
});
