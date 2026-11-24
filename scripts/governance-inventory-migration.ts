import {
  estimateTenantLegacyLocatorMoves,
  listGovernedOrganizationIds,
  makeDynamoDatabase,
  moveTenantLegacyLocators,
  Ulid,
  type LegacyLocatorMoveCost,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { parseArgs } from "node:util";
import {
  GOVERNANCE_INVENTORY_SHARDS_MARKER,
  governanceInventoryShardsRechecked,
  writeDeployMigrationMarker,
  type PlatformTables,
} from "./platform-deploy/governance-inventory-shards-migration.ts";
import { dynamoPlatformTables } from "./platform-deploy/installation-record.ts";
import { runMain, type Environment } from "./platform-deploy/process.ts";
import { tofuOutput, tofuRoot } from "./tofu-output.ts";

const USAGE =
  "Usage: bun scripts/governance-inventory-migration.ts --root <opentofu-root-dir> [--region <region>] [--dry-run] [--org <organization-id>]... [--write-units-per-second <units>] [--time-budget-minutes <minutes>]";
const DEFAULT_WRITE_UNITS_PER_SECOND = 1_000;
// Static environment credentials cannot refresh, so a run ends inside a one-hour role session.
const DEFAULT_TIME_BUDGET_MINUTES = 50;
// DynamoDB on-demand, Standard table class, us-east-1 and us-east-2:
// https://aws.amazon.com/dynamodb/pricing/on-demand/
const DOLLARS_PER_WRITE_UNIT = 0.625 / 1_000_000;
const DOLLARS_PER_READ_UNIT = 0.125 / 1_000_000;

interface CommandTarget {
  readonly organizations: "all" | readonly [string, ...string[]];
  readonly region: string;
  readonly root: string;
  readonly writeUnitsPerSecond: number;
}

export type GovernanceInventoryMigrationCommand =
  | (CommandTarget & { readonly kind: "dry-run" })
  | (CommandTarget & { readonly kind: "move"; readonly timeBudgetMinutes: number });

export type GovernanceInventoryMigrationResult =
  | {
      readonly kind: "estimated";
      readonly locators: number;
      readonly organizations: number;
      readonly readUnits: number;
      readonly writeUnits: number;
    }
  | {
      readonly kind: "completed" | "stopped";
      readonly moved: number;
      readonly organizations: number;
      readonly writeUnits: number;
    };

function positiveNumber(value: string | undefined, flag: string, fallback: number) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${flag} must be a positive number.\n${USAGE}`);
  }
  return number;
}

export function parseGovernanceInventoryMigrationCommand(
  args: readonly string[],
  environment: Environment,
): GovernanceInventoryMigrationCommand {
  const { values } = parseArgs({
    args: [...args],
    options: {
      "dry-run": { type: "boolean" },
      org: { multiple: true, type: "string" },
      region: { type: "string" },
      root: { type: "string" },
      "time-budget-minutes": { type: "string" },
      "write-units-per-second": { type: "string" },
    },
  });
  const root = tofuRoot(values.root, USAGE);
  const region = (
    values.region ??
    environment.AWS_REGION ??
    environment.AWS_DEFAULT_REGION
  )?.trim();
  if (!region) throw new Error(`A region is required.\n${USAGE}`);
  const invalid = values.org?.find((id) => !Schema.is(Ulid)(id));
  if (invalid !== undefined) {
    throw new Error(`--org ${invalid} is not a 26-character ULID organization id.\n${USAGE}`);
  }
  const [first, ...rest] = values.org ?? [];
  const target = {
    organizations: first === undefined ? ("all" as const) : ([first, ...rest] as const),
    region,
    root,
    writeUnitsPerSecond: positiveNumber(
      values["write-units-per-second"],
      "--write-units-per-second",
      DEFAULT_WRITE_UNITS_PER_SECOND,
    ),
  };
  if (values["dry-run"]) {
    if (values["time-budget-minutes"] !== undefined) {
      throw new Error(`--time-budget-minutes does not apply to --dry-run.\n${USAGE}`);
    }
    return { ...target, kind: "dry-run" };
  }
  return {
    ...target,
    kind: "move",
    timeBudgetMinutes: positiveNumber(
      values["time-budget-minutes"],
      "--time-budget-minutes",
      DEFAULT_TIME_BUDGET_MINUTES,
    ),
  };
}

const units = new Intl.NumberFormat("en-US");
const dollars = new Intl.NumberFormat("en-US", { currency: "USD", style: "currency" });
const hours = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
});

function describeCost(cost: LegacyLocatorMoveCost) {
  const price = cost.writeUnits * DOLLARS_PER_WRITE_UNIT + cost.readUnits * DOLLARS_PER_READ_UNIT;
  return `${units.format(cost.locators)} legacy locators, ${units.format(cost.writeUnits)} write units, ${units.format(cost.readUnits)} read units, ${dollars.format(price)}`;
}

export interface GovernanceInventoryMigrationRun {
  readonly command: GovernanceInventoryMigrationCommand;
  readonly tables: PlatformTables;
  /** Epoch milliseconds. */
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly write: (line: string) => void;
}

async function estimate({
  command,
  tables,
  write,
}: GovernanceInventoryMigrationRun): Promise<GovernanceInventoryMigrationResult> {
  const organizationIds =
    command.organizations === "all"
      ? await listGovernedOrganizationIds(tables.client, tables.tableNames)
      : command.organizations;
  let total: LegacyLocatorMoveCost = { locators: 0, readUnits: 0, writeUnits: 0 };
  for (const organizationId of organizationIds) {
    const cost = await estimateTenantLegacyLocatorMoves(tables, organizationId);
    write(`${organizationId}: ${describeCost(cost)}`);
    total = {
      locators: total.locators + cost.locators,
      readUnits: total.readUnits + cost.readUnits,
      writeUnits: total.writeUnits + cost.writeUnits,
    };
  }
  write(
    `total across ${units.format(organizationIds.length)} organizations: ${describeCost(total)} (estimates at DynamoDB on-demand prices)`,
  );
  write(
    `moving them at ${units.format(command.writeUnitsPerSecond)} write units per second takes about ${hours.format(total.writeUnits / command.writeUnitsPerSecond / 3_600)} hours`,
  );
  return { ...total, kind: "estimated", organizations: organizationIds.length };
}

async function move(
  { now, sleep, tables, write }: GovernanceInventoryMigrationRun,
  command: Extract<GovernanceInventoryMigrationCommand, { kind: "move" }>,
): Promise<GovernanceInventoryMigrationResult> {
  const database = makeDynamoDatabase(tables.client, tables.tableNames);
  if (!(await governanceInventoryShardsRechecked(database))) {
    throw new Error(
      "Legacy governance inventory locators cannot move yet: a deploy must first switch shard writes on and re-check shard locators.",
    );
  }
  const organizationIds =
    command.organizations === "all"
      ? await listGovernedOrganizationIds(tables.client, tables.tableNames)
      : command.organizations;
  const startedAt = now();
  const deadline = startedAt + command.timeBudgetMinutes * 60_000;
  let moved = 0;
  let writeUnits = 0;
  const stop = (organizationId: string) => {
    write(
      `stopped at the ${command.timeBudgetMinutes}-minute time budget at ${organizationId} after moving ${units.format(moved)} legacy locators this run; rerun to continue where it stopped`,
    );
    return { kind: "stopped", moved, organizations: organizationIds.length, writeUnits } as const;
  };
  for (const organizationId of organizationIds) {
    if (now() >= deadline) return stop(organizationId);
    let movedInOrganization = 0;
    for await (const page of moveTenantLegacyLocators(tables, organizationId)) {
      moved += page.locators;
      movedInOrganization += page.locators;
      writeUnits += page.writeUnits;
      const due = startedAt + (writeUnits / command.writeUnitsPerSecond) * 1_000;
      const wait = due - now();
      if (wait > 0) await sleep(wait);
      if (now() >= deadline) return stop(organizationId);
    }
    write(`${organizationId}: moved ${units.format(movedInOrganization)} legacy locators`);
  }
  if (
    command.organizations === "all" &&
    !(await database.getRecord("control", GOVERNANCE_INVENTORY_SHARDS_MARKER, true))
  ) {
    await writeDeployMigrationMarker(database, "governance-inventory-shards");
    write("no legacy governance inventory locator is left; wrote the completion marker");
  }
  return { kind: "completed", moved, organizations: organizationIds.length, writeUnits };
}

export async function runGovernanceInventoryMigration(
  run: GovernanceInventoryMigrationRun,
): Promise<GovernanceInventoryMigrationResult> {
  switch (run.command.kind) {
    case "dry-run":
      return estimate(run);
    case "move":
      return move(run, run.command);
    default: {
      const exhaustive: never = run.command;
      return exhaustive;
    }
  }
}

async function main() {
  const command = parseGovernanceInventoryMigrationCommand(process.argv.slice(2), process.env);
  await runGovernanceInventoryMigration({
    command,
    now: Date.now,
    sleep: (milliseconds) => Bun.sleep(milliseconds),
    tables: dynamoPlatformTables(
      { dynamodb_table_names: tofuOutput(command.root, "dynamodb_table_names") },
      command.region,
    ),
    write: (line) => process.stdout.write(`${line}\n`),
  });
}

if (import.meta.main) runMain(main);
