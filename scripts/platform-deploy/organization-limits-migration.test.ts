import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  DEFAULT_TABLE_NAMES,
  GovernanceTenantRecordRecord,
  governanceObjectDigests,
  governanceRecordTimestamp,
  governanceTenantDirectoryKey,
  key,
  makeDynamoDatabase,
  makeDynamoGovernanceStore,
  makeIdGenerator,
  makeOrganizationStandingRepository,
  OrganizationRecord,
  StandingActor,
  tableNamesFromEnvironment,
  withCanonicalRecordKeys,
  type TableNames,
  Ulid,
} from "@deployments-ai/db";
import { fakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  migrateOrganizationLimits,
  type OrganizationLimitsMigration,
} from "./organization-limits-migration.ts";
import { reconcileOrganization } from "./organization-gate-lanes-migration.ts";

const AT = "2026-09-01T00:00:00.000Z";
const LEGACY_OPERATOR = Schema.decodeUnknownSync(Ulid)("01J9ZQ5Y5V7Q8R3X2K4M6N8P0B");
const OPERATOR_ID = Schema.decodeUnknownSync(Ulid)("01J9ZQ5Y5V7Q8R3X2K4M6N8P0C");
const OPERATOR = Schema.decodeUnknownSync(StandingActor)({
  kind: "operator",
  principalId: OPERATOR_ID,
});
const BILLING = Schema.decodeUnknownSync(StandingActor)({ kind: "service", service: "billing" });
const INSTALL_DEFAULTS = {
  operatorFundedModelSpendCeiling: "unlimited",
  tenantLimits: {
    activeSandboxes: 2,
    apiRequestBurst: 40,
    apiRequestsPerSecond: 20,
    concurrentRuns: 4,
  },
} as const;
const COMPLETION_MARKER = {
  pk: "GLOBAL#deploy-migration",
  sk: "DEPLOY-MIGRATION#organization-limits",
};
const endpoint = process.env.AWS_ENDPOINT_URL_DYNAMODB;

type LocatorPlacement = "legacy partition" | "shard";

const stores: readonly {
  readonly name: string;
  readonly skip: boolean;
  readonly open: () => { readonly client: DynamoDBDocumentClient; readonly tableNames: TableNames };
}[] = [
  {
    name: "fake DynamoDB",
    open: () => ({ client: fakeDynamoDocumentClient().client, tableNames: DEFAULT_TABLE_NAMES }),
    skip: false,
  },
  {
    name: "local DynamoDB",
    open: () => ({
      client: DynamoDBDocumentClient.from(
        new DynamoDBClient({
          ...(endpoint ? { endpoint } : {}),
          region: process.env.AWS_REGION ?? "us-east-1",
        }),
        { marshallOptions: { removeUndefinedValues: true } },
      ),
      tableNames: tableNamesFromEnvironment(),
    }),
    skip: !endpoint,
  },
];

for (const store of stores) {
  describe.skipIf(store.skip)(`organization limits migration on ${store.name}`, () => {
    const ids = makeIdGenerator();

    async function installation() {
      const tables = store.open();
      const control = tables.tableNames.control;
      const send = tables.client.send.bind(tables.client);
      const sent: string[] = [];
      let beforeSend: ((command: object) => Promise<void>) | undefined;
      tables.client.send = (async (command: object) => {
        const hook = beforeSend;
        if (hook) await hook(command);
        sent.push(command.constructor.name);
        return send(command as never);
      }) as typeof tables.client.send;
      const put = (item: object) => send(new PutCommand({ Item: item, TableName: control }));
      await send(new DeleteCommand({ Key: COMPLETION_MARKER, TableName: control }));
      const standing = makeOrganizationStandingRepository({
        database: makeDynamoDatabase(tables.client, tables.tableNames),
        installDefaults: INSTALL_DEFAULTS,
      });
      const legacyKey = (id: Ulid) => ({ pk: key("ORG", id), sk: key("ORGANIZATION-LIMITS", id) });
      const shardLocatorKey = (id: Ulid) =>
        governanceTenantDirectoryKey(id, "control", legacyKey(id).pk, legacyKey(id).sk);
      const legacyLocatorKey = (id: Ulid) => ({
        pk: key("ORG", id, "GOVERNANCE-INVENTORY"),
        sk: shardLocatorKey(id).sk,
      });
      const legacy = async (
        id: Ulid,
        overrides: Record<string, number>,
        version = 2,
        locatorAt: LocatorPlacement = "legacy partition",
      ) => {
        const item = {
          data: {
            createdAt: AT,
            id,
            organizationId: id,
            overrides,
            reason: "ticket OPS-311",
            updatedAt: AT,
            updatedBy: LEGACY_OPERATOR,
            version,
          },
          itemType: "organization-limits",
          ...legacyKey(id),
        };
        const recordTimestamp = governanceRecordTimestamp(item);
        await put(item);
        const locator = Schema.decodeUnknownSync(GovernanceTenantRecordRecord)(
          withCanonicalRecordKeys({
            data: {
              organizationId: id,
              recordItemType: item.itemType,
              recordObjectDigests: governanceObjectDigests(item),
              recordPk: item.pk,
              recordSk: item.sk,
              recordTable: "control",
              ...(recordTimestamp === undefined ? {} : { recordTimestamp }),
            },
            itemType: "governance-tenant-record" as const,
          }),
        );
        await put(locatorAt === "shard" ? locator : { ...locator, ...legacyLocatorKey(id) });
      };
      const organization = async (
        overrides?: Record<string, number>,
        locatorAt: LocatorPlacement = "legacy partition",
      ) => {
        const id = ids.generate();
        await put(
          Schema.decodeUnknownSync(OrganizationRecord)(
            withCanonicalRecordKeys({
              data: {
                createdAt: AT,
                id,
                name: "Migrated",
                slug: `migrated-${id.toLowerCase()}`,
                status: "active",
                updatedAt: AT,
                version: 1,
              },
              itemType: "organization" as const,
            }),
          ),
        );
        await reconcileOrganization(tables, id);
        if (overrides) await legacy(id, overrides, 2, locatorAt);
        return id;
      };
      const grantsOf = async (organizationId: Ulid) => {
        const { grants, standing: effective } = await standing.readWithGrants(organizationId, {
          consistent: true,
        });
        return {
          operator: grants.operator && {
            entitlements: grants.operator.entitlements,
            grantedBy: grants.operator.grantedBy,
          },
          service: grants.service?.entitlements,
          version: effective.version,
        };
      };
      const stored = async (keyOf: typeof legacyKey, organizationIds: readonly Ulid[]) => {
        const left: Ulid[] = [];
        for (const id of organizationIds) {
          const { Item } = await send(
            new GetCommand({ ConsistentRead: true, Key: keyOf(id), TableName: control }),
          );
          if (Item) left.push(id);
        }
        return left;
      };
      const legacyLeft = (...organizationIds: Ulid[]) => stored(legacyKey, organizationIds);
      const locatorsLeft = async (...organizationIds: Ulid[]) => {
        const onLegacyPartition = await stored(legacyLocatorKey, organizationIds);
        const onShard = await stored(shardLocatorKey, organizationIds);
        return organizationIds.filter(
          (id) => onLegacyPartition.includes(id) || onShard.includes(id),
        );
      };
      const governance = makeDynamoGovernanceStore(tables.client, tables.tableNames);
      const inventory = async (organizationId: Ulid) => {
        const itemTypes: string[] = [];
        let cursor: string | undefined;
        try {
          do {
            const page = await governance.listTenantRecords(organizationId, cursor);
            itemTypes.push(...page.items.map(({ record }) => record.itemType));
            cursor = page.cursor;
          } while (cursor);
        } catch (cause) {
          return cause instanceof Error ? cause.message : String(cause);
        }
        return itemTypes.toSorted();
      };
      const completed = async () =>
        (
          await send(
            new GetCommand({ ConsistentRead: true, Key: COMPLETION_MARKER, TableName: control }),
          )
        ).Item !== undefined;
      const crashBefore = (matches: (command: object) => boolean) => {
        beforeSend = async (command) => {
          if (!matches(command)) return;
          beforeSend = undefined;
          throw new Error("deploy host lost");
        };
      };
      const onFirst = (matches: (command: object) => boolean, effect: () => Promise<unknown>) => {
        beforeSend = async (command) => {
          if (!matches(command)) return;
          beforeSend = undefined;
          await effect();
        };
      };
      return {
        completed,
        crashBefore,
        grantsOf,
        inventory,
        legacy,
        legacyKey,
        legacyLeft,
        locatorsLeft,
        onFirst,
        organization,
        send,
        sent,
        standing,
        tables,
      };
    }

    const retiring = (command: object) =>
      command instanceof TransactWriteCommand &&
      (command.input.TransactItems ?? []).some((item) =>
        String(item.Delete?.Key?.sk).startsWith("ORGANIZATION-LIMITS#"),
      );

    const sweptFor = async (
      run: Promise<OrganizationLimitsMigration>,
      organizationIds: readonly Ulid[],
    ) => {
      const result = await run;
      if (result.kind !== "swept") return result;
      const mine = (migrated: readonly Ulid[]) =>
        migrated.filter((id) => organizationIds.includes(id)).toSorted();
      return {
        copied: mine(result.copied),
        kind: result.kind,
        remaining: mine(result.remaining),
        retired: mine(result.retired),
      };
    };

    test("copies each override into the operator grant, keeping fields the grant already sets, and deletes the override with its inventory locator", async () => {
      const { grantsOf, inventory, legacyLeft, locatorsLeft, organization, standing, tables } =
        await installation();
      const fresh = await organization({ activeSandboxes: 16, concurrentRuns: 32 });
      const granted = await organization({ apiRequestsPerSecond: 50, concurrentRuns: 32 });
      const cleared = await organization({});
      const untouched = await organization();
      await standing.setGrant({
        actor: OPERATOR,
        entitlements: {
          operatorFundedModelSpendCeiling: { monthlyUsdMicros: 1_000_000 },
          tenantLimits: { concurrentRuns: 8 },
        },
        organizationId: granted,
      });
      await standing.setGrant({
        actor: BILLING,
        entitlements: { tenantLimits: { concurrentRuns: 16 } },
        organizationId: granted,
      });
      const inventoryBefore = await inventory(cleared);

      const result = await sweptFor(migrateOrganizationLimits(tables), [
        fresh,
        granted,
        cleared,
        untouched,
      ]);

      expect(result).toEqual({
        copied: [fresh, granted].toSorted(),
        kind: "swept",
        remaining: [],
        retired: [cleared],
      });
      expect(await grantsOf(fresh)).toEqual({
        operator: {
          entitlements: { tenantLimits: { activeSandboxes: 16, concurrentRuns: 32 } },
          grantedBy: { kind: "operator", principalId: LEGACY_OPERATOR },
        },
        service: undefined,
        version: 1,
      });
      expect(await grantsOf(granted)).toEqual({
        operator: {
          entitlements: {
            operatorFundedModelSpendCeiling: { monthlyUsdMicros: 1_000_000 },
            tenantLimits: { apiRequestsPerSecond: 50, concurrentRuns: 8 },
          },
          grantedBy: { kind: "operator", principalId: LEGACY_OPERATOR },
        },
        service: { tenantLimits: { concurrentRuns: 16 } },
        version: 3,
      });
      expect([await grantsOf(cleared), await grantsOf(untouched)]).toEqual([
        { operator: undefined, service: undefined, version: 0 },
        { operator: undefined, service: undefined, version: 0 },
      ]);
      expect(
        (await standing.listHistory({ limit: 5, organizationId: fresh })).items.map((change) => [
          change.standingVersion,
          change.actor,
          change.change.kind,
        ]),
      ).toEqual([[1, { kind: "operator", principalId: LEGACY_OPERATOR }, "grant-set"]]);
      expect(await legacyLeft(fresh, granted, cleared, untouched)).toEqual([]);
      expect(await locatorsLeft(fresh, granted, cleared)).toEqual([]);
      expect(inventoryBefore).toBe(
        "DynamoDB item does not match a registered platform record schema.",
      );
      expect([await inventory(fresh), await inventory(cleared)]).toEqual([
        ["organization-standing", "organization-standing-change", "semantic-event"],
        [],
      ]);
    });

    test("never brings back a grant the operator cleared after the migration", async () => {
      const { grantsOf, legacyLeft, organization, standing, tables } = await installation();
      const migrated = await organization({ concurrentRuns: 32 });
      await migrateOrganizationLimits(tables);
      await standing.clearGrant({ actor: OPERATOR, organizationId: migrated });

      await migrateOrganizationLimits(tables);

      expect(await grantsOf(migrated)).toEqual({
        operator: undefined,
        service: undefined,
        version: 2,
      });
      expect(await legacyLeft(migrated)).toEqual([]);
    });

    test("after a crash between the grant write and the delete, keeps the grant the operator wrote since", async () => {
      const { crashBefore, grantsOf, legacyLeft, organization, standing, tables } =
        await installation();
      const migrated = await organization({ concurrentRuns: 32 });
      crashBefore(retiring);
      const crashed = await migrateOrganizationLimits(tables).then(
        () => "finished",
        () => "crashed",
      );
      await standing.setGrant({
        actor: OPERATOR,
        entitlements: { tenantLimits: { activeSandboxes: 8 } },
        organizationId: migrated,
      });

      const rerun = await sweptFor(migrateOrganizationLimits(tables), [migrated]);

      expect(crashed).toBe("crashed");
      expect(rerun).toEqual({ copied: [], kind: "swept", remaining: [], retired: [migrated] });
      expect(await grantsOf(migrated)).toEqual({
        operator: {
          entitlements: { tenantLimits: { activeSandboxes: 8 } },
          grantedBy: { kind: "operator", principalId: OPERATOR_ID },
        },
        service: undefined,
        version: 2,
      });
      expect(await legacyLeft(migrated)).toEqual([]);
    });

    test("after a crash before the grant write, copies the override on the next run", async () => {
      const { crashBefore, grantsOf, legacyLeft, organization, standing, tables } =
        await installation();
      const migrated = await organization({ concurrentRuns: 32 });
      crashBefore((command) => command instanceof TransactWriteCommand);
      const crashed = await migrateOrganizationLimits(tables).then(
        () => "finished",
        () => "crashed",
      );
      await standing.setGrant({
        actor: BILLING,
        entitlements: { tenantLimits: { activeSandboxes: 3 } },
        organizationId: migrated,
      });

      const rerun = await sweptFor(migrateOrganizationLimits(tables), [migrated]);

      expect(crashed).toBe("crashed");
      expect(rerun).toEqual({ copied: [migrated], kind: "swept", remaining: [], retired: [] });
      expect(await grantsOf(migrated)).toEqual({
        operator: {
          entitlements: { tenantLimits: { concurrentRuns: 32 } },
          grantedBy: { kind: "operator", principalId: LEGACY_OPERATOR },
        },
        service: { tenantLimits: { activeSandboxes: 3 } },
        version: 2,
      });
      expect(await legacyLeft(migrated)).toEqual([]);
    });

    test("leaves an override changed during the sweep for the next deploy", async () => {
      const { completed, grantsOf, legacy, legacyLeft, onFirst, organization, tables } =
        await installation();
      const migrated = await organization({ concurrentRuns: 32 });
      onFirst(
        (command) => command instanceof PutCommand,
        () => legacy(migrated, { concurrentRuns: 64 }, 3),
      );

      const first = await sweptFor(migrateOrganizationLimits(tables), [migrated]);
      const state = [await grantsOf(migrated), await legacyLeft(migrated), await completed()];
      const second = await sweptFor(migrateOrganizationLimits(tables), [migrated]);

      expect(first).toEqual({ copied: [], kind: "swept", remaining: [migrated], retired: [] });
      expect(state).toEqual([
        { operator: undefined, service: undefined, version: 0 },
        [migrated],
        false,
      ]);
      expect(second).toEqual({ copied: [migrated], kind: "swept", remaining: [], retired: [] });
      expect((await grantsOf(migrated)).operator?.entitlements).toEqual({
        tenantLimits: { concurrentRuns: 64 },
      });
    });

    test("drops a legacy burst below the rate the operator grant sets", async () => {
      const { grantsOf, legacyLeft, organization, standing, tables } = await installation();
      const migrated = await organization({ activeSandboxes: 6, apiRequestBurst: 5 });
      await standing.setGrant({
        actor: OPERATOR,
        entitlements: { tenantLimits: { apiRequestsPerSecond: 10 } },
        organizationId: migrated,
      });

      await migrateOrganizationLimits(tables);

      expect((await grantsOf(migrated)).operator?.entitlements).toEqual({
        tenantLimits: { activeSandboxes: 6, apiRequestsPerSecond: 10 },
      });
      expect(await legacyLeft(migrated)).toEqual([]);
    });

    test("keeps the item and its locator together when the override changes before the delete", async () => {
      const {
        completed,
        inventory,
        legacy,
        legacyLeft,
        locatorsLeft,
        onFirst,
        organization,
        tables,
      } = await installation();
      const migrated = await organization({ concurrentRuns: 32 });
      onFirst(retiring, () => legacy(migrated, { concurrentRuns: 64 }, 4));

      const first = await sweptFor(migrateOrganizationLimits(tables), [migrated]);
      const state = [await legacyLeft(migrated), await locatorsLeft(migrated), await completed()];
      const second = await sweptFor(migrateOrganizationLimits(tables), [migrated]);

      expect(first).toEqual({ copied: [], kind: "swept", remaining: [migrated], retired: [] });
      expect(state).toEqual([[migrated], [migrated], false]);
      expect(second).toEqual({ copied: [], kind: "swept", remaining: [], retired: [migrated] });
      expect([await legacyLeft(migrated), await locatorsLeft(migrated)]).toEqual([[], []]);
      expect(await inventory(migrated)).toEqual([
        "organization-standing",
        "organization-standing-change",
        "semantic-event",
      ]);
    });

    test("deletes the override with the locator a reader already moved to its shard", async () => {
      const { inventory, legacyLeft, locatorsLeft, organization, tables } = await installation();
      const moved = await organization({ concurrentRuns: 32 }, "shard");

      const result = await sweptFor(migrateOrganizationLimits(tables), [moved]);

      expect(result).toEqual({ copied: [moved], kind: "swept", remaining: [], retired: [] });
      expect([await legacyLeft(moved), await locatorsLeft(moved)]).toEqual([[], []]);
      expect(await inventory(moved)).toEqual([
        "organization-standing",
        "organization-standing-change",
        "semantic-event",
      ]);
    });

    test("deletes a legacy-partition locator whose legacy item an earlier run already deleted", async () => {
      const { completed, inventory, legacyKey, locatorsLeft, organization, send, tables } =
        await installation();
      const orphaned = await organization({ concurrentRuns: 32 });
      await send(
        new DeleteCommand({ Key: legacyKey(orphaned), TableName: tables.tableNames.control }),
      );
      const locatorsBefore = await locatorsLeft(orphaned);

      const result = await sweptFor(migrateOrganizationLimits(tables), [orphaned]);

      expect(locatorsBefore).toEqual([orphaned]);
      expect(result).toEqual({ copied: [], kind: "swept", remaining: [], retired: [] });
      expect(await locatorsLeft(orphaned)).toEqual([]);
      expect(await inventory(orphaned)).toEqual([]);
      expect(await completed()).toBe(true);
    });

    test("deletes a shard locator whose legacy item an earlier run already deleted", async () => {
      const { completed, inventory, legacyKey, locatorsLeft, organization, send, tables } =
        await installation();
      const orphaned = await organization({ concurrentRuns: 32 }, "shard");
      await send(
        new DeleteCommand({ Key: legacyKey(orphaned), TableName: tables.tableNames.control }),
      );
      const inventoryBefore = await inventory(orphaned);

      const result = await sweptFor(migrateOrganizationLimits(tables), [orphaned]);

      expect(inventoryBefore).toBe(
        "Governance inventory does not resolve to its canonical tenant record.",
      );
      expect(result).toEqual({ copied: [], kind: "swept", remaining: [], retired: [] });
      expect(await locatorsLeft(orphaned)).toEqual([]);
      expect(await inventory(orphaned)).toEqual([]);
      expect(await completed()).toBe(true);
    });

    test("once complete, a deploy reads one item however many organizations exist", async () => {
      const { organization, sent, tables } = await installation();
      for (let created = 0; created < 250; created += 1) await organization();
      const first = await migrateOrganizationLimits(tables);
      sent.length = 0;

      const second = await migrateOrganizationLimits(tables);

      expect([first.kind, second.kind]).toEqual(["swept", "already-complete"]);
      expect(sent).toEqual(["GetCommand"]);
    });
  });
}
