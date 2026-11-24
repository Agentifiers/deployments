import { QueryCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  DEFAULT_TABLE_NAMES,
  governanceTenantDirectoryRecord,
  makeDynamoDatabase,
  withCanonicalRecordKeys,
  type PlatformRecord,
} from "@deployments-ai/db";
import {
  fakeDynamoDocumentClient,
  type FakeDynamoDocumentClient,
} from "@deployments-ai/db/dynamo-testing";
import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  parseGovernanceInventoryMigrationCommand,
  runGovernanceInventoryMigration,
} from "./governance-inventory-migration.ts";
import {
  GOVERNANCE_INVENTORY_SHARDS_MARKER,
  writeDeployMigrationMarker,
} from "./platform-deploy/governance-inventory-shards-migration.ts";
import type { Environment } from "./platform-deploy/process.ts";

const AT = "2026-10-01T00:00:00.000Z";
const ORG_A = "01J9ZQ5Y5V7Q8R3X2K4M6N8P1A";
const ORG_B = "01J9ZQ5Y5V7Q8R3X2K4M6N8P1B";
const CONTROL = DEFAULT_TABLE_NAMES.control;
const USAGE = DEFAULT_TABLE_NAMES.usage;
const ROOT = path.resolve("infrastructure");

function organization(id: string) {
  return withCanonicalRecordKeys({
    data: {
      createdAt: AT,
      id,
      name: id,
      slug: id.toLowerCase(),
      status: "active",
      updatedAt: AT,
      version: 1,
    },
    itemType: "organization" as const,
  }) as unknown as PlatformRecord;
}

function counter(organizationId: string, limitKey: string) {
  const expiresAt = "2027-01-01T00:00:00.000Z";
  return withCanonicalRecordKeys({
    data: {
      count: 1,
      expiresAt,
      limitKey,
      organizationId,
      scopeId: organizationId,
      version: 1,
      window: "2026-10-01T00",
    },
    itemType: "rate-limit-counter" as const,
    ttl: Math.floor(Date.parse(expiresAt) / 1_000),
  }) as unknown as PlatformRecord;
}

const legacyPartition = (organizationId: string) => `ORG#${organizationId}#GOVERNANCE-INVENTORY`;

function legacyLocators(fake: FakeDynamoDocumentClient, organizationId: string) {
  return fake.items(CONTROL).filter((item) => item.pk === legacyPartition(organizationId)).length;
}

function shardLocators(fake: FakeDynamoDocumentClient, organizationId: string) {
  return fake
    .items(CONTROL)
    .filter(
      (item) =>
        item.itemType === "governance-tenant-record" &&
        String(item.pk).startsWith(`${legacyPartition(organizationId)}#SHARD#`),
    ).length;
}

async function seeded({ rechecked }: { readonly rechecked: boolean }) {
  const fake = fakeDynamoDocumentClient();
  for (const [organizationId, count] of [
    [ORG_A, 250],
    [ORG_B, 3],
  ] as const) {
    fake.put(CONTROL, organization(organizationId));
    for (let index = 0; index < count; index += 1) {
      const record = counter(organizationId, `legacy.${String(index).padStart(3, "0")}`);
      const locator = governanceTenantDirectoryRecord(record)!;
      fake.put(USAGE, record);
      fake.put(CONTROL, { ...locator, pk: legacyPartition(organizationId) });
    }
  }
  const database = makeDynamoDatabase(fake.client, DEFAULT_TABLE_NAMES);
  await writeDeployMigrationMarker(database, "governance-inventory-shard-writes");
  if (rechecked) await writeDeployMigrationMarker(database, "governance-inventory-shard-recheck");
  return fake;
}

function command(args: readonly string[]) {
  return parseGovernanceInventoryMigrationCommand(["--root", "infrastructure", ...args], {
    AWS_REGION: "us-east-2",
  });
}

function fakeClock() {
  let time = 0;
  const sleeps: number[] = [];
  return {
    now: () => time,
    sleep: async (milliseconds: number) => {
      sleeps.push(milliseconds);
      time += milliseconds;
    },
    sleeps,
  };
}

function run(client: DynamoDBDocumentClient, args: readonly string[]) {
  const clock = fakeClock();
  const lines: string[] = [];
  return {
    lines,
    result: runGovernanceInventoryMigration({
      command: command(args),
      now: clock.now,
      sleep: clock.sleep,
      tables: { client, tableNames: DEFAULT_TABLE_NAMES },
      write: (line) => lines.push(line),
    }),
    sleeps: clock.sleeps,
  };
}

function completionMarker(fake: FakeDynamoDocumentClient) {
  return fake.get(CONTROL, GOVERNANCE_INVENTORY_SHARDS_MARKER)?.data;
}

describe("governance inventory migration", () => {
  test("a dry run prints each organization's estimate and moves nothing", async () => {
    const fake = await seeded({ rechecked: false });
    const dryRun = run(fake.client, ["--dry-run", "--write-units-per-second", "0.1"]);

    expect(await dryRun.result).toEqual({
      kind: "estimated",
      locators: 253,
      organizations: 2,
      readUnits: 539,
      writeUnits: 1_518,
    });
    expect(dryRun.lines).toEqual([
      "01J9ZQ5Y5V7Q8R3X2K4M6N8P1A: 250 legacy locators, 1,500 write units, 532 read units, $0.00",
      "01J9ZQ5Y5V7Q8R3X2K4M6N8P1B: 3 legacy locators, 18 write units, 7 read units, $0.00",
      "total across 2 organizations: 253 legacy locators, 1,518 write units, 539 read units, $0.00 (estimates at DynamoDB on-demand prices)",
      "moving them at 0.1 write units per second takes about 4.22 hours",
    ]);
    expect(fake.transactions.length).toBe(0);
    expect(legacyLocators(fake, ORG_A)).toBe(250);
    expect(legacyLocators(fake, ORG_B)).toBe(3);
  });

  test("a move before a deploy re-checked shard locators writes nothing", async () => {
    const fake = await seeded({ rechecked: false });

    expect(await run(fake.client, []).result.catch((cause: Error) => cause.message)).toBe(
      "Legacy governance inventory locators cannot move yet: a deploy must first switch shard writes on and re-check shard locators.",
    );
    expect(fake.transactions.length).toBe(0);
    expect(legacyLocators(fake, ORG_A)).toBe(250);
    expect(legacyLocators(fake, ORG_B)).toBe(3);
  });

  test("a run that reaches its time budget stops, and a rerun moves only what is left", async () => {
    const fake = await seeded({ rechecked: true });

    const first = run(fake.client, ["--time-budget-minutes", "0.01"]);
    expect(await first.result).toEqual({
      kind: "stopped",
      moved: 100,
      organizations: 2,
      writeUnits: 600,
    });
    expect(first.lines).toEqual([
      "stopped at the 0.01-minute time budget at 01J9ZQ5Y5V7Q8R3X2K4M6N8P1A after moving 100 legacy locators this run; rerun to continue where it stopped",
    ]);
    expect(legacyLocators(fake, ORG_A)).toBe(150);
    expect(shardLocators(fake, ORG_A)).toBe(100);
    expect(completionMarker(fake)).toBeUndefined();

    let legacyItemsRead = 0;
    const recording = {
      send: async (sent: QueryCommand) => {
        const result = await fake.client.send(sent);
        const partition = String(sent.input.ExpressionAttributeValues?.[":inventory"]);
        if (
          sent instanceof QueryCommand &&
          [ORG_A, ORG_B].map(legacyPartition).includes(partition)
        ) {
          legacyItemsRead += result.Items?.length ?? 0;
        }
        return result;
      },
    } as unknown as DynamoDBDocumentClient;
    const rerun = run(recording, []);
    expect(await rerun.result).toEqual({
      kind: "completed",
      moved: 153,
      organizations: 2,
      writeUnits: 918,
    });
    expect(rerun.lines).toEqual([
      "01J9ZQ5Y5V7Q8R3X2K4M6N8P1A: moved 150 legacy locators",
      "01J9ZQ5Y5V7Q8R3X2K4M6N8P1B: moved 3 legacy locators",
      "no legacy governance inventory locator is left; wrote the completion marker",
    ]);
    expect(legacyItemsRead).toBe(153);
    expect(legacyLocators(fake, ORG_A)).toBe(0);
    expect(legacyLocators(fake, ORG_B)).toBe(0);
    expect(shardLocators(fake, ORG_A)).toBe(250);
    expect(shardLocators(fake, ORG_B)).toBe(3);
    expect(completionMarker(fake)).toEqual({
      completedAt: expect.any(String),
      id: "governance-inventory-shards",
    });

    const marker = completionMarker(fake);
    const repeated = run(fake.client, []);
    expect(await repeated.result).toEqual({
      kind: "completed",
      moved: 0,
      organizations: 2,
      writeUnits: 0,
    });
    expect(repeated.lines).toEqual([
      "01J9ZQ5Y5V7Q8R3X2K4M6N8P1A: moved 0 legacy locators",
      "01J9ZQ5Y5V7Q8R3X2K4M6N8P1B: moved 0 legacy locators",
    ]);
    expect(completionMarker(fake)).toEqual(marker);
  });

  test("moves are paced to the write budget", async () => {
    const fake = await seeded({ rechecked: true });
    const paced = run(fake.client, ["--write-units-per-second", "100"]);

    expect(await paced.result).toEqual({
      kind: "completed",
      moved: 253,
      organizations: 2,
      writeUnits: 1_518,
    });
    expect(paced.sleeps).toEqual([6_000, 6_000, 3_000, 180]);
  });

  test("an organization filter moves only those organizations and leaves the completion marker unwritten", async () => {
    const fake = await seeded({ rechecked: true });
    const filtered = run(fake.client, ["--org", ORG_B]);

    expect(await filtered.result).toEqual({
      kind: "completed",
      moved: 3,
      organizations: 1,
      writeUnits: 18,
    });
    expect(filtered.lines).toEqual(["01J9ZQ5Y5V7Q8R3X2K4M6N8P1B: moved 3 legacy locators"]);
    expect(legacyLocators(fake, ORG_A)).toBe(250);
    expect(legacyLocators(fake, ORG_B)).toBe(0);
    expect(completionMarker(fake)).toBeUndefined();
  });
});

describe("parseGovernanceInventoryMigrationCommand", () => {
  test("defaults to moving every organization at 1,000 write units per second for 50 minutes", () => {
    expect(command([])).toEqual({
      kind: "move",
      organizations: "all",
      region: "us-east-2",
      root: ROOT,
      timeBudgetMinutes: 50,
      writeUnitsPerSecond: 1_000,
    });
  });

  test("a dry run takes repeated organizations, a write budget, and the region flag over the environment", () => {
    expect(
      command([
        "--dry-run",
        "--org",
        ORG_A,
        "--org",
        ORG_B,
        "--write-units-per-second",
        "250.5",
        "--region",
        "us-east-1",
      ]),
    ).toEqual({
      kind: "dry-run",
      organizations: [ORG_A, ORG_B],
      region: "us-east-1",
      root: ROOT,
      writeUnitsPerSecond: 250.5,
    });
  });

  test("rejects invalid input with the usage", () => {
    const usage =
      "Usage: bun scripts/governance-inventory-migration.ts --root <opentofu-root-dir> [--region <region>] [--dry-run] [--org <organization-id>]... [--write-units-per-second <units>] [--time-budget-minutes <minutes>]";
    const message = (
      args: readonly string[],
      environment: Environment = { AWS_REGION: "us-east-2" },
    ) => {
      try {
        parseGovernanceInventoryMigrationCommand(args, environment);
        return "parsed";
      } catch (cause) {
        return cause instanceof Error ? cause.message : String(cause);
      }
    };

    expect(message(["--org", ORG_A])).toBe(`--root is required.\n${usage}`);
    expect(message(["--root", "infrastructure", "--org", "org-a"])).toBe(
      `--org org-a is not a 26-character ULID organization id.\n${usage}`,
    );
    expect(message(["--root", "infrastructure", "--write-units-per-second", "0"])).toBe(
      `--write-units-per-second must be a positive number.\n${usage}`,
    );
    expect(message(["--root", "infrastructure", "--time-budget-minutes=-5"])).toBe(
      `--time-budget-minutes must be a positive number.\n${usage}`,
    );
    expect(message(["--root", "infrastructure", "--time-budget-minutes", "Infinity"])).toBe(
      `--time-budget-minutes must be a positive number.\n${usage}`,
    );
    expect(message(["--root", "infrastructure", "--dry-run", "--time-budget-minutes", "5"])).toBe(
      `--time-budget-minutes does not apply to --dry-run.\n${usage}`,
    );
    expect(message(["--root", "infrastructure"], {})).toBe(`A region is required.\n${usage}`);
  });
});
