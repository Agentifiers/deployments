import { TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { activeOrganizationCondition } from "../brains/authorization-conditions.ts";
import { makeDynamoDatabase } from "../dynamo-database.ts";
import { createHash } from "node:crypto";
import { makeDynamoGovernanceStore, operationRecord } from "../governance/dynamo-store.ts";
import { Ulid } from "../ids.ts";
import { OrganizationGateLaneRecord } from "../records/organization-gate.ts";
import {
  decodePlatformRecord,
  withCanonicalRecordKeys,
  type PlatformRecord,
} from "../records/index.ts";
import {
  fakeDynamoDocumentClient,
  type FakeDynamoDocumentClient,
} from "../testing/dynamo-document-client.fixture.ts";
import { makeUniqueClaimRecord, uniqueClaimRequirements } from "../unique-claims.ts";
import { organizationGateCheck } from "./requirements.ts";

const AT = "2026-10-01T00:00:00.000Z";
const LEASE = "2099-01-01T00:00:00.000Z";
const ulid = Schema.decodeUnknownSync(Ulid);
const decodeLane = Schema.decodeUnknownSync(OrganizationGateLaneRecord);
const ORG = ulid("01J9ZQ5Y5V7Q8R3X2K4M6N8Q0A");
const OPERATION = ulid("01J9ZQ5Y5V7Q8R3X2K4M6N8Q0B");
const ACTOR = ulid("01J9ZQ5Y5V7Q8R3X2K4M6N8Q0C");
const TARGET = ulid("01J9ZQ5Y5V7Q8R3X2K4M6N8Q0D");
const NEXT_TARGET = ulid("01J9ZQ5Y5V7Q8R3X2K4M6N8Q0E");
const PROVIDER_TARGET = ulid("01J9ZQ5Y5V7Q8R3X2K4M6N8Q0F");

function decoded<const T extends PlatformRecord["itemType"]>(
  itemType: T,
  data: Readonly<Record<string, unknown>>,
) {
  return Effect.runSync(
    decodePlatformRecord(withCanonicalRecordKeys({ data, itemType })),
  ) as Extract<PlatformRecord, { readonly itemType: T }>;
}

const organization = (status: "active" | "disabled", version: number) =>
  decoded("organization", {
    createdAt: AT,
    id: ORG,
    name: "Gates",
    slug: "gates",
    status,
    updatedAt: AT,
    version,
  });

const searchTarget = (targetId: Ulid) => ({
  components: [{ componentId: targetId, kind: "dense" }],
  embeddingProfileId: targetId,
  location: { region: "aws-us-east-2" },
  providerId: "aws-native",
  schemaGeneration: 1,
  targetId,
});

const brainPlacement = (targetId: Ulid, generation: number, version: number) =>
  decoded("brain-search-placement", {
    createdAt: AT,
    generation,
    organizationId: ORG,
    phase: "active",
    readTarget: searchTarget(targetId),
    updatedAt: AT,
    version,
    writeTarget: searchTarget(targetId),
  });

const providerGate = (status: "closed" | "draining" | "open", version: number) =>
  decoded("memory-provider-mutation-gate", {
    createdAt: AT,
    drainEpoch: 0,
    organizationId: ORG,
    status,
    targetId: PROVIDER_TARGET,
    updatedAt: AT,
    version,
  });

const auditEvent = (eventId: string) =>
  decoded("audit-event", {
    action: "organization.created",
    actor: { id: ACTOR, type: "principal" },
    eventId,
    occurredAt: AT,
    organizationId: ORG,
  });

function seeded() {
  const fake = fakeDynamoDocumentClient();
  const org = organization("active", 1);
  fake.put("control", org);
  for (const requirement of uniqueClaimRequirements(org)) {
    fake.put("control", makeUniqueClaimRecord(requirement, AT));
  }
  fake.put("control", brainPlacement(TARGET, 1, 1));
  fake.put("control", providerGate("open", 1));
  return {
    database: makeDynamoDatabase(fake.client),
    fake,
    governance: makeDynamoGovernanceStore(fake.client, {
      control: "control",
      events: "events",
      execution: "execution",
      usage: "usage",
    }),
  };
}

function lanes(fake: FakeDynamoDocumentClient) {
  return fake
    .items("control")
    .filter((item) => item.itemType === "organization-gate-lane")
    .map((item) => decodeLane(item).data);
}

/** The gate state every lane holds, once; a split brain between lanes shows up as two entries. */
function laneStates(fake: FakeDynamoDocumentClient) {
  return [
    ...new Set(
      lanes(fake).map(({ createdAt: _c, lane: _l, updatedAt: _u, ...state }) =>
        JSON.stringify(state),
      ),
    ),
  ].map((state) => JSON.parse(state) as unknown);
}

async function outcome(write: Promise<unknown>) {
  return write.then(
    () => "committed",
    () => "refused",
  );
}

describe("organization gate lanes", () => {
  test("seeded organizations hold 32 identical lanes", () => {
    const { fake } = seeded();

    expect(lanes(fake).map(({ lane }) => lane)).toEqual(Array.from({ length: 32 }, (_, i) => i));
    expect(laneStates(fake)).toEqual([
      {
        brainSearchPlacement: { generation: 1, phase: "active", version: 1 },
        memoryProviderGates: { [PROVIDER_TARGET]: "open" },
        organization: { status: "active" },
        organizationId: ORG,
        version: 2,
      },
    ]);
  });

  test("taking the erasure fence closes every lane in the fence transaction, and releasing it reopens them", async () => {
    const { database, fake, governance } = seeded();
    const fence = {
      createdAt: AT,
      leaseExpiresAt: LEASE,
      operationId: OPERATION,
      organizationId: ORG,
    };

    await governance.beginErasure(fence);
    const fenceTransaction = fake.transactions.at(-1)!;
    const fenced = await outcome(
      database.transactWrite([{ kind: "put", record: auditEvent("01J9ZQ5Y5V7Q8R3X2K4M6N8Q1A") }]),
    );
    const owned = await outcome(
      database.transactWriteForErasure!(
        [{ kind: "put", record: auditEvent("01J9ZQ5Y5V7Q8R3X2K4M6N8Q1B") }],
        { operationId: OPERATION, organizationId: ORG },
      ),
    );
    const fencedState = laneStates(fake);
    await governance.releaseErasureFence(fence);
    const released = await outcome(
      database.transactWrite([{ kind: "put", record: auditEvent("01J9ZQ5Y5V7Q8R3X2K4M6N8Q1C") }]),
    );

    expect(fenceTransaction.outcome).toBe("applied");
    expect(
      fenceTransaction.input.TransactItems?.filter((item) =>
        String(item.Put?.Item?.sk).startsWith("ORGANIZATION-GATE-LANE#"),
      ),
    ).toHaveLength(32);
    expect(fencedState).toEqual([
      {
        brainSearchPlacement: { generation: 1, phase: "active", version: 1 },
        erasureFence: { leaseExpiresAt: LEASE, operationId: OPERATION },
        memoryProviderGates: { [PROVIDER_TARGET]: "open" },
        organization: { status: "active" },
        organizationId: ORG,
        version: 3,
      },
    ]);
    expect([fenced, owned, released]).toEqual(["refused", "committed", "committed"]);
    expect(laneStates(fake)).toEqual([
      {
        brainSearchPlacement: { generation: 1, phase: "active", version: 1 },
        memoryProviderGates: { [PROVIDER_TARGET]: "open" },
        organization: { status: "active" },
        organizationId: ORG,
        version: 4,
      },
    ]);
  });

  test("an organization status change moves every lane in the same transaction", async () => {
    const { database, fake } = seeded();
    const brainWrite = (eventId: string) => [
      activeOrganizationCondition(ORG),
      { kind: "put" as const, record: auditEvent(eventId) },
    ];

    const before = await outcome(database.transactWrite(brainWrite("01J9ZQ5Y5V7Q8R3X2K4M6N8Q2A")));
    await database.transactWrite([
      {
        kind: "put",
        previousRecord: organization("active", 1),
        record: organization("disabled", 2),
      },
    ]);
    const after = await outcome(database.transactWrite(brainWrite("01J9ZQ5Y5V7Q8R3X2K4M6N8Q2B")));

    expect(
      fake.transactions
        .at(-2)
        ?.input.TransactItems?.filter((item) =>
          String(item.Put?.Item?.sk).startsWith("ORGANIZATION-GATE-LANE#"),
        ),
    ).toHaveLength(32);
    expect(laneStates(fake)).toEqual([
      {
        brainSearchPlacement: { generation: 1, phase: "active", version: 1 },
        memoryProviderGates: { [PROVIDER_TARGET]: "open" },
        organization: { status: "disabled" },
        organizationId: ORG,
        version: 3,
      },
    ]);
    expect([before, after]).toEqual(["committed", "refused"]);
  });

  test("a placement change moves every lane, so writes routed to the old generation are refused", async () => {
    const { database, fake } = seeded();
    const enqueue = (eventId: string, generation: number, version: number) => [
      organizationGateCheck(ORG, { generation, kind: "brain-search-placement-active", version }),
      { kind: "put" as const, record: auditEvent(eventId) },
    ];

    await database.transactWrite([
      {
        kind: "put",
        previousRecord: brainPlacement(TARGET, 1, 1),
        record: brainPlacement(NEXT_TARGET, 2, 2),
      },
    ]);
    const stale = await outcome(
      database.transactWrite(enqueue("01J9ZQ5Y5V7Q8R3X2K4M6N8Q3A", 1, 1)),
    );
    const current = await outcome(
      database.transactWrite(enqueue("01J9ZQ5Y5V7Q8R3X2K4M6N8Q3B", 2, 2)),
    );

    expect(laneStates(fake)).toEqual([
      {
        brainSearchPlacement: { generation: 2, phase: "active", version: 2 },
        memoryProviderGates: { [PROVIDER_TARGET]: "open" },
        organization: { status: "active" },
        organizationId: ORG,
        version: 3,
      },
    ]);
    expect([stale, current]).toEqual(["refused", "committed"]);
  });

  test("of two gate changes that read the same lanes, the later one is cancelled whole", async () => {
    const { database, fake } = seeded();
    const read = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const waiting = {
      send: async (command: unknown) => {
        if (command instanceof TransactWriteCommand) {
          read.resolve();
          await held.promise;
        }
        return fake.client.send(command as never);
      },
    } as unknown as DynamoDBDocumentClient;

    const drain = makeDynamoDatabase(waiting).transactWrite([
      { kind: "put", previousRecord: providerGate("open", 1), record: providerGate("draining", 2) },
    ]);
    await read.promise;
    await database.transactWrite([
      {
        kind: "put",
        previousRecord: brainPlacement(TARGET, 1, 1),
        record: brainPlacement(NEXT_TARGET, 2, 2),
      },
    ]);
    held.resolve();

    expect(await outcome(drain)).toBe("refused");
    expect(laneStates(fake)).toEqual([
      {
        brainSearchPlacement: { generation: 2, phase: "active", version: 2 },
        memoryProviderGates: { [PROVIDER_TARGET]: "open" },
        organization: { status: "active" },
        organizationId: ORG,
        version: 3,
      },
    ]);
    expect(
      fake.items("control").find((item) => item.itemType === "memory-provider-mutation-gate")?.data,
    ).toMatchObject({ status: "open", version: 1 });
  });

  test("finalizing tenant erasure deletes every lane with the organization, so no tenant write lands after", async () => {
    const { database, fake, governance } = seeded();
    const operation = {
      createdAt: AT,
      id: OPERATION,
      idempotencyKey: "erase",
      kind: "tenant-erasure" as const,
      organizationId: ORG,
      requestedByPrincipalId: ACTOR,
      startedAt: AT,
      status: "running" as const,
      updatedAt: AT,
      version: 2,
    };
    fake.put("control", operationRecord(operation));
    await governance.beginErasure({ createdAt: AT, operationId: OPERATION, organizationId: ORG });

    await governance.finalizeErasure(
      operation,
      {
        auditRootHash: "0".repeat(64),
        completedAt: AT,
        id: OPERATION,
        organizationHash: createHash("sha256").update(ORG).digest("hex"),
        recordsDeleted: 0,
        requestedByPrincipalHash: createHash("sha256").update(ACTOR).digest("hex"),
      },
      2,
    );
    const finalize = fake.transactions.at(-1)!;
    const after = await outcome(
      database.transactWrite([{ kind: "put", record: auditEvent("01J9ZQ5Y5V7Q8R3X2K4M6N8Q4A") }]),
    );

    expect(finalize.outcome).toBe("applied");
    expect(
      finalize.input.TransactItems?.filter((item) =>
        String(item.Delete?.Key?.sk).startsWith("ORGANIZATION-GATE-LANE#"),
      ),
    ).toHaveLength(32);
    expect(lanes(fake)).toEqual([]);
    expect(after).toBe("refused");
  });

  test("single-record writes refuse gate sources and lanes", async () => {
    const { database, fake } = seeded();
    const lane = decodeLane(
      fake.items("control").find((item) => item.itemType === "organization-gate-lane"),
    );

    const refused = await Promise.all([
      outcome(database.putRecord(organization("active", 2))),
      outcome(database.putRecord(providerGate("closed", 2))),
      outcome(database.putRecord(lane)),
      outcome(database.deleteRecord(brainPlacement(TARGET, 1, 1))),
      outcome(database.deleteRecord(lane)),
    ]);

    expect(refused).toEqual(["refused", "refused", "refused", "refused", "refused"]);
  });
});
