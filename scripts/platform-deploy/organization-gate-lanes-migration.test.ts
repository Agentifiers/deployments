import {
  PutCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import {
  DEFAULT_TABLE_NAMES,
  makeDynamoDatabase,
  makeDynamoGovernanceStore,
  OrganizationGateLaneRecord,
  Ulid,
  withCanonicalRecordKeys,
} from "@deployments-ai/db";
import { fakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { reconcileOrganizationGateLanes } from "./organization-gate-lanes-migration.ts";

const AT = "2026-10-01T00:00:00.000Z";
const ulid = Schema.decodeUnknownSync(Ulid);
const decodeLane = Schema.decodeUnknownSync(OrganizationGateLaneRecord);
const ORG_A = ulid("01J9ZQ5Y5V7Q8R3X2K4M6N8P1A");
const ORG_B = ulid("01J9ZQ5Y5V7Q8R3X2K4M6N8P1B");
const TARGET = ulid("01J9ZQ5Y5V7Q8R3X2K4M6N8P1C");
const OPERATION = ulid("01J9ZQ5Y5V7Q8R3X2K4M6N8P1D");
const ACTOR = ulid("01J9ZQ5Y5V7Q8R3X2K4M6N8P1E");
const tables = (client: DynamoDBDocumentClient) => ({ client, tableNames: DEFAULT_TABLE_NAMES });

const organization = (id: Ulid, slug: string) =>
  withCanonicalRecordKeys({
    data: { createdAt: AT, id, name: slug, slug, status: "active", updatedAt: AT, version: 1 },
    itemType: "organization" as const,
  });

const providerGate = (status: "closed" | "draining" | "open", version: number) =>
  withCanonicalRecordKeys({
    data: {
      createdAt: AT,
      drainEpoch: 0,
      organizationId: ORG_A,
      status,
      targetId: TARGET,
      updatedAt: AT,
      version,
    },
    itemType: "memory-provider-mutation-gate" as const,
  });

const erasureFence = withCanonicalRecordKeys({
  data: { createdAt: AT, id: ORG_A, operationId: OPERATION, organizationId: ORG_A },
  itemType: "erasure-fence" as const,
});

const auditEvent = (eventId: Ulid) =>
  withCanonicalRecordKeys({
    data: {
      action: "organization.created",
      actor: { id: ACTOR, type: "principal" },
      eventId,
      occurredAt: AT,
      organizationId: ORG_A,
    },
    itemType: "audit-event" as const,
  });

/** What code that predates lanes leaves behind: gate sources written without any lane. */
async function legacyPut(client: DynamoDBDocumentClient, item: object) {
  await client.send(new PutCommand({ Item: item, TableName: "control" }));
}

function lanes(items: readonly Record<string, unknown>[], organizationId: Ulid) {
  return items
    .filter((item) => item.itemType === "organization-gate-lane")
    .map((item) => decodeLane(item))
    .filter((lane) => lane.data.organizationId === organizationId);
}

async function tenantWrite(client: DynamoDBDocumentClient, eventId: Ulid) {
  return outcome(
    makeDynamoDatabase(client).transactWrite([{ kind: "put", record: auditEvent(eventId) }]),
  );
}

/** A client whose next transactions wait, after their reads, until `release` is called. */
function holdingTransactions(client: DynamoDBDocumentClient) {
  const read = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  return {
    client: {
      send: async (command: unknown) => {
        if (command instanceof TransactWriteCommand) {
          read.resolve();
          await held.promise;
        }
        return client.send(command as never);
      },
    } as unknown as DynamoDBDocumentClient,
    read: read.promise,
    release: () => held.resolve(),
  };
}

async function outcome(write: Promise<unknown>) {
  return write.then(
    () => "committed",
    () => "refused",
  );
}

describe("organization gate lane reconcile", () => {
  test("creates 32 lanes per organization from its gate sources, then finds nothing to do", async () => {
    const fake = fakeDynamoDocumentClient();
    await legacyPut(fake.client, organization(ORG_A, "alpha"));
    await legacyPut(fake.client, providerGate("open", 3));
    await legacyPut(fake.client, organization(ORG_B, "beta"));

    const first = await reconcileOrganizationGateLanes(tables(fake.client));
    const second = await reconcileOrganizationGateLanes(tables(fake.client));

    expect(first).toEqual({ current: 0, repaired: [ORG_A, ORG_B] });
    expect(second).toEqual({ current: 2, repaired: [] });
    const laneA = lanes(fake.items("control"), ORG_A);
    expect(laneA.map(({ data: { lane } }) => lane)).toEqual(
      Array.from({ length: 32 }, (_, i) => i),
    );
    expect(laneA[0]?.sk).toBe("ORGANIZATION-GATE-LANE#00");
    expect(
      laneA.map(({ data: { createdAt: _c, lane: _l, updatedAt: _u, ...state } }) => state),
    ).toEqual(
      Array.from({ length: 32 }, () => ({
        memoryProviderGates: { [TARGET]: "open" },
        organization: { status: "active" },
        organizationId: ORG_A,
        version: 0,
      })),
    );
    expect(lanes(fake.items("control"), ORG_B)).toHaveLength(32);
  });

  test("refuses tenant writes for an organization without lanes and admits them once reconciled", async () => {
    const fake = fakeDynamoDocumentClient();
    await legacyPut(fake.client, organization(ORG_A, "alpha"));

    const before = await tenantWrite(fake.client, ulid("01J9ZQ5Y5V7Q8R3X2K4M6N8P2A"));
    await reconcileOrganizationGateLanes(tables(fake.client));
    const after = await tenantWrite(fake.client, ulid("01J9ZQ5Y5V7Q8R3X2K4M6N8P2B"));

    expect([before, after]).toEqual(["refused", "committed"]);
  });

  test("repairs lanes a pre-lane writer left stale, so a fence it took closes every lane", async () => {
    const fake = fakeDynamoDocumentClient();
    await legacyPut(fake.client, organization(ORG_A, "alpha"));
    await legacyPut(fake.client, providerGate("open", 3));
    await reconcileOrganizationGateLanes(tables(fake.client));
    await legacyPut(fake.client, providerGate("draining", 4));
    await legacyPut(fake.client, erasureFence);
    const staleWrite = await tenantWrite(fake.client, ulid("01J9ZQ5Y5V7Q8R3X2K4M6N8P2C"));

    const result = await reconcileOrganizationGateLanes(tables(fake.client));
    const repairedWrite = await tenantWrite(fake.client, ulid("01J9ZQ5Y5V7Q8R3X2K4M6N8P2D"));

    expect(result).toEqual({ current: 0, repaired: [ORG_A] });
    expect(
      lanes(fake.items("control"), ORG_A).map(({ data }) => ({
        erasureFence: data.erasureFence,
        memoryProviderGates: data.memoryProviderGates,
        version: data.version,
      })),
    ).toEqual(
      Array.from({ length: 32 }, () => ({
        erasureFence: { operationId: OPERATION },
        memoryProviderGates: { [TARGET]: "draining" },
        version: 1,
      })),
    );
    expect([staleWrite, repairedWrite]).toEqual(["committed", "refused"]);
  });

  test("reads again when a pre-lane writer changes a gate source between its read and its write", async () => {
    const fake = fakeDynamoDocumentClient();
    await legacyPut(fake.client, organization(ORG_A, "alpha"));
    await legacyPut(fake.client, providerGate("open", 3));
    let raced = false;
    const racing = {
      send: async (command: unknown) => {
        if (command instanceof TransactWriteCommand && !raced) {
          raced = true;
          await legacyPut(fake.client, providerGate("draining", 4));
        }
        return fake.client.send(command as never);
      },
    } as unknown as DynamoDBDocumentClient;

    const result = await reconcileOrganizationGateLanes(tables(racing));

    expect(result).toEqual({ current: 0, repaired: [ORG_A] });
    expect(fake.transactions.map(({ outcome }) => outcome)).toEqual(["failed", "applied"]);
    expect(lanes(fake.items("control"), ORG_A).map(({ data }) => data.memoryProviderGates)).toEqual(
      Array.from({ length: 32 }, () => ({ [TARGET]: "draining" })),
    );
  });

  test("two reconcile runs that read the same missing lanes converge on one set of 32", async () => {
    const fake = fakeDynamoDocumentClient();
    await legacyPut(fake.client, organization(ORG_A, "alpha"));
    await legacyPut(fake.client, providerGate("open", 3));
    const first = holdingTransactions(fake.client);
    const second = holdingTransactions(fake.client);

    const runs = Promise.all([
      reconcileOrganizationGateLanes(tables(first.client)),
      reconcileOrganizationGateLanes(tables(second.client)),
    ]);
    await Promise.all([first.read, second.read]);
    first.release();
    second.release();

    expect(await runs).toEqual([
      { current: 0, repaired: [ORG_A] },
      { current: 1, repaired: [] },
    ]);
    expect(fake.transactions.map(({ outcome }) => outcome)).toEqual(["applied", "failed"]);
    expect(
      lanes(fake.items("control"), ORG_A).map(({ data }) => ({
        lane: data.lane,
        memoryProviderGates: data.memoryProviderGates,
        version: data.version,
      })),
    ).toEqual(
      Array.from({ length: 32 }, (_, lane) => ({
        lane,
        memoryProviderGates: { [TARGET]: "open" },
        version: 0,
      })),
    );
  });

  test("a fence that read no lanes is cancelled when a reconcile creates them first", async () => {
    const fake = fakeDynamoDocumentClient();
    await legacyPut(fake.client, organization(ORG_A, "alpha"));
    const holding = holdingTransactions(fake.client);
    const fence = { createdAt: AT, operationId: OPERATION, organizationId: ORG_A };

    const racing = outcome(
      makeDynamoGovernanceStore(holding.client, DEFAULT_TABLE_NAMES).beginErasure(fence),
    );
    await holding.read;
    await reconcileOrganizationGateLanes(tables(fake.client));
    holding.release();
    const raced = await racing;
    await makeDynamoGovernanceStore(fake.client, DEFAULT_TABLE_NAMES).beginErasure(fence);
    const fencedWrite = await tenantWrite(fake.client, ulid("01J9ZQ5Y5V7Q8R3X2K4M6N8P2E"));

    expect(raced).toBe("refused");
    expect(lanes(fake.items("control"), ORG_A).map(({ data }) => data.erasureFence)).toEqual(
      Array.from({ length: 32 }, () => ({ operationId: OPERATION })),
    );
    expect(fencedWrite).toBe("refused");
  });

  test("a provider drain that read no lanes is cancelled when a reconcile creates them first", async () => {
    const fake = fakeDynamoDocumentClient();
    await legacyPut(fake.client, organization(ORG_A, "alpha"));
    await legacyPut(fake.client, providerGate("open", 3));
    const holding = holdingTransactions(fake.client);
    const drain = (client: DynamoDBDocumentClient) =>
      makeDynamoDatabase(client).transactWrite([
        {
          kind: "put",
          previousRecord: providerGate("open", 3),
          record: providerGate("draining", 4),
        },
      ]);

    const racing = outcome(drain(holding.client));
    await holding.read;
    await reconcileOrganizationGateLanes(tables(fake.client));
    holding.release();
    const raced = await racing;
    const retried = await outcome(drain(fake.client));

    expect([raced, retried]).toEqual(["refused", "committed"]);
    expect(lanes(fake.items("control"), ORG_A).map(({ data }) => data.memoryProviderGates)).toEqual(
      Array.from({ length: 32 }, () => ({ [TARGET]: "draining" })),
    );
  });

  test("a gate change on an organization without lanes checks its sources, and the reconcile copies it", async () => {
    const fake = fakeDynamoDocumentClient();
    await legacyPut(fake.client, organization(ORG_A, "alpha"));
    await legacyPut(fake.client, providerGate("open", 3));
    const gateChange = (
      from: Parameters<typeof providerGate>,
      to: Parameters<typeof providerGate>,
    ) =>
      outcome(
        makeDynamoDatabase(fake.client).transactWrite([
          { kind: "put", previousRecord: providerGate(...from), record: providerGate(...to) },
        ]),
      );

    const drained = await gateChange(["open", 3], ["draining", 4]);
    const unreconciledWrite = await tenantWrite(fake.client, ulid("01J9ZQ5Y5V7Q8R3X2K4M6N8P2F"));
    await legacyPut(fake.client, erasureFence);
    const closedUnderFence = await gateChange(["draining", 4], ["closed", 5]);
    await reconcileOrganizationGateLanes(tables(fake.client));

    expect([drained, unreconciledWrite, closedUnderFence]).toEqual([
      "committed",
      "refused",
      "refused",
    ]);
    expect(
      lanes(fake.items("control"), ORG_A).map(({ data }) => ({
        erasureFence: data.erasureFence,
        memoryProviderGates: data.memoryProviderGates,
      })),
    ).toEqual(
      Array.from({ length: 32 }, () => ({
        erasureFence: { operationId: OPERATION },
        memoryProviderGates: { [TARGET]: "draining" },
      })),
    );
  });
});
