import { WorkflowDefinitionDocumentV1 } from "@deployments-ai/api-contract";
import {
  DatabaseError,
  Keys,
  Ulid,
  tableForItemType,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TableName,
  type TransactionOperation,
} from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { makeControlResourceApiServices } from "./control-resource-api.ts";
import type { ApiInvocation } from "./index.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY";

function storageKey(table: TableName, record: { readonly pk: string; readonly sk: string }) {
  return `${table}\u0000${record.pk}\u0000${record.sk}`;
}

function makeDatabase(transactionBatches: PlatformRecord[][] = []) {
  const records = new Map<string, PlatformRecord>();
  const put = (record: PlatformRecord) =>
    records.set(storageKey(tableForItemType(record.itemType), record), structuredClone(record));
  const database: DynamoDatabaseService = {
    deleteRecord: async (record) => {
      records.delete(storageKey(tableForItemType(record.itemType), record));
    },
    getRecord: async (table, recordKey) => {
      const record = records.get(storageKey(table, recordKey));
      return record ? structuredClone(record) : undefined;
    },
    putRecord: async (record) => {
      put(record);
    },
    queryRecords: async (table, input) => {
      const names = input.ExpressionAttributeNames as Record<string, string>;
      const values = input.ExpressionAttributeValues as Record<string, unknown>;
      const partitionName = names["#pk"] ?? "pk";
      const sortName = names["#sk"] ?? "sk";
      const partition = values[":pk"];
      const prefix = String(values[":prefix"]);
      const matching = [...records.values()]
        .filter((record) => tableForItemType(record.itemType) === table)
        .filter((record) => {
          const indexed = record as unknown as Record<string, unknown>;
          return (
            indexed[partitionName] === partition && String(indexed[sortName]).startsWith(prefix)
          );
        })
        .toSorted((left, right) => left.sk.localeCompare(right.sk));
      const exclusiveStartKey = input.ExclusiveStartKey as
        | { readonly pk: string; readonly sk: string }
        | undefined;
      const start = exclusiveStartKey
        ? matching.findIndex(
            (record) => record.pk === exclusiveStartKey.pk && record.sk === exclusiveStartKey.sk,
          ) + 1
        : 0;
      const limit = input.Limit ?? 50;
      const items = matching.slice(start, start + limit).map((record) => structuredClone(record));
      const last = items.at(-1);
      return {
        items,
        ...(last && start + items.length < matching.length
          ? { lastEvaluatedKey: { pk: last.pk, sk: last.sk } }
          : {}),
      };
    },
    transactWrite: async (operations) => {
      for (const operation of operations) {
        if (operation.kind !== "put") continue;
        const existing = records.get(
          storageKey(tableForItemType(operation.record.itemType), operation.record),
        );
        const expectedVersion = operation.previousRecord
          ? (operation.previousRecord.data as { readonly version?: number }).version
          : undefined;
        const actualVersion = existing
          ? (existing.data as { readonly version?: number }).version
          : undefined;
        if (
          (operation.previousRecord && actualVersion !== expectedVersion) ||
          (!operation.previousRecord && !operation.allowExisting && existing)
        ) {
          throw new DatabaseError({
            cause: new Error("simulated conditional conflict"),
            message: "Conditional write failed.",
            operation: "transact-write",
            reason: "conflict",
            table: "control",
          });
        }
      }
      transactionBatches.push(
        operations.flatMap((operation) =>
          operation.kind === "condition-check" ? [] : [structuredClone(operation.record)],
        ),
      );
      for (const operation of operations) {
        if (operation.kind === "condition-check") continue;
        if (operation.kind === "delete") {
          records.delete(storageKey(tableForItemType(operation.record.itemType), operation.record));
        } else {
          put(operation.record);
        }
      }
    },
  };

  const environmentKey = { pk: "environment-pk", sk: "environment-sk" };
  const claimKey = Keys.control.uniqueClaim("environment-id", ENVIRONMENT_ID);
  records.set(storageKey("control", claimKey), {
    ...claimKey,
    data: {
      namespace: "environment-id",
      ownerId: ENVIRONMENT_ID,
      ownerItemType: "environment",
      ownerPk: environmentKey.pk,
      ownerSk: environmentKey.sk,
      value: ENVIRONMENT_ID,
    },
    itemType: "unique-claim",
  } as unknown as PlatformRecord);
  records.set(storageKey("control", environmentKey), {
    ...environmentKey,
    data: {
      id: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      status: "active",
    },
    itemType: "environment",
  } as unknown as PlatformRecord);
  return database;
}

function invocation<Body>(
  body: Body,
  options: {
    readonly id?: string;
    readonly query?: ApiInvocation["query"];
  } = {},
): ApiInvocation<Body> {
  return {
    body,
    ...(options.id ? { id: options.id } : {}),
    identity: {
      environmentIds: [ENVIRONMENT_ID],
      organizationIds: [ORGANIZATION_ID],
      principalId: PRINCIPAL_ID,
      projectIds: [PROJECT_ID],
      scopes: ["platform:*"],
    },
    query: options.query ?? {},
    scope: {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    },
  };
}

function idGenerator() {
  const characters = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let index = 0;
  return async () =>
    Schema.decodeUnknownSync(Ulid)(
      `01ARZ3NDEKTSV4RRFFQ69G5F${characters[Math.floor(index / 32)]}${characters[index++ % 32]}`,
    );
}

describe("control resource API services", () => {
  test("validates managed-skill dependencies and supports inspection and installation", async () => {
    const transactionBatches: PlatformRecord[][] = [];
    const conditionChecks: Array<
      Extract<TransactionOperation, { readonly kind: "condition-check" }>
    > = [];
    const baseDatabase = makeDatabase(transactionBatches);
    const database: DynamoDatabaseService = {
      ...baseDatabase,
      transactWrite: (operations, clientRequestToken, signal) => {
        conditionChecks.push(
          ...operations.filter(
            (
              operation,
            ): operation is Extract<TransactionOperation, { readonly kind: "condition-check" }> =>
              operation.kind === "condition-check",
          ),
        );
        return baseDatabase.transactWrite(operations, clientRequestToken, signal);
      },
    };
    const services = makeControlResourceApiServices({
      database,
      generateId: idGenerator(),
      now: () => new Date("2026-07-25T12:00:00.000Z"),
    });
    const source = await services.managedSkillSources.create(
      invocation({ key: "release-tools", name: "Release tools" }),
    );
    expect(
      services.managedSkillSources.create(
        invocation({ key: "release-tools", name: "Duplicate release tools" }),
      ),
    ).rejects.toMatchObject({
      code: "managed_skill_source_key_conflict",
      kind: "conflict",
    });

    expect(
      services.managedSkillReleases.publish(
        invocation(
          {
            expectedSourceVersion: 0,
            releaseVersion: "1.0.0",
            skills: [
              {
                content: "# Deploy",
                dependencies: ["missing"],
                key: "deploy",
              },
            ],
          },
          { id: String(source.id) },
        ),
      ),
    ).rejects.toMatchObject({
      code: "managed_skill_dependency_missing",
      kind: "unprocessable",
    });

    expect(
      services.managedSkillReleases.publish(
        invocation(
          {
            expectedSourceVersion: 0,
            releaseVersion: "1.0.0",
            skills: [
              { content: "# Verify", key: "verify" },
              {
                content: "# Deploy",
                dependencies: Array.from({ length: 16_000 }, () => "verify"),
                key: "deploy",
              },
            ],
          },
          { id: String(source.id) },
        ),
      ),
    ).rejects.toMatchObject({
      code: "managed_skill_item_too_large",
      kind: "invalid-input",
    });

    const release = await services.managedSkillReleases.publish(
      invocation(
        {
          expectedSourceVersion: 0,
          manifest: { channel: "stable" },
          releaseVersion: "1.0.0",
          skills: [
            { content: "# Verify", key: "verify" },
            {
              content: "# Deploy",
              dependencies: ["verify"],
              key: "deploy",
            },
          ],
        },
        { id: String(source.id) },
      ),
    );
    expect(
      services.managedSkillReleases.publish(
        invocation(
          {
            expectedSourceVersion: 1,
            releaseVersion: "1.0.0",
            skills: [{ content: "# Duplicate", key: "duplicate" }],
          },
          { id: String(source.id) },
        ),
      ),
    ).rejects.toMatchObject({
      code: "managed_skill_release_conflict",
      kind: "conflict",
    });
    const skills = await services.managedSkills.list(
      invocation(undefined, { id: String(release.id) }),
    );
    const verify = skills.items.find((skill) => skill.key === "verify")!;
    const deploy = skills.items.find((skill) => skill.key === "deploy")!;
    const inspected = await services.managedSkills.get(
      invocation(undefined, { id: String(deploy.id) }),
    );

    expect(release.skillCount).toBe(2);
    expect(deploy.dependencies).toEqual([verify.id]);
    expect(inspected.content).toBe("# Deploy");

    const installation = await services.managedSkillInstallations.install(
      invocation({
        managedSkillId: deploy.id,
        managedSkillReleaseId: release.id,
      }),
    );
    expect(
      services.managedSkillInstallations.install(
        invocation({
          managedSkillId: deploy.id,
          managedSkillReleaseId: release.id,
        }),
      ),
    ).rejects.toMatchObject({
      code: "managed_skill_install_conflict",
      kind: "conflict",
    });
    const removed = await services.managedSkillInstallations.remove(
      invocation({ expectedVersion: installation.version }, { id: String(installation.id) }),
    );
    expect(installation.status).toBe("active");
    expect(removed).toMatchObject({ status: "removed", version: 1 });
    expect(
      services.managedSkillInstallations.remove(
        invocation({ expectedVersion: removed.version }, { id: String(removed.id) }),
      ),
    ).rejects.toMatchObject({
      code: "resource_inactive",
      kind: "conflict",
    });
    expect(conditionChecks).toContainEqual({
      conditionExpression: "#data.#status = :active AND #data.#version = :version",
      expressionAttributeNames: {
        "#data": "data",
        "#status": "status",
        "#version": "version",
      },
      expressionAttributeValues: {
        ":active": "active",
        ":version": 0,
      },
      key: {
        pk: "GLOBAL#managed-skill-release",
        sk: `MANAGED-SKILL-RELEASE#${release.id}`,
      },
      kind: "condition-check",
      table: "control",
    });
    expect(
      transactionBatches.some(
        (batch) =>
          batch.some((record) => record.itemType === "managed-skill-installation") &&
          batch.some(
            (record) =>
              record.itemType === "semantic-event" &&
              record.data.eventType === "managed-skill-installation.created",
          ),
      ),
    ).toBe(true);
    expect(
      transactionBatches.some((batch) =>
        batch.some(
          (record) =>
            record.itemType === "semantic-event" &&
            record.data.eventType === "managed-skill-installation.deleted",
        ),
      ),
    ).toBe(true);

    const conflictingServices = makeControlResourceApiServices({
      database: {
        ...database,
        transactWrite: (operations) =>
          operations.some(
            (operation) =>
              operation.kind === "condition-check" &&
              operation.key.sk === `MANAGED-SKILL-RELEASE#${release.id}`,
          )
            ? Promise.reject(
                new DatabaseError({
                  cause: new Error("simulated concurrent release archival"),
                  message: "Conditional write failed.",
                  operation: "transact-write",
                  reason: "conflict",
                  table: "control",
                }),
              )
            : database.transactWrite(operations),
      },
      generateId: idGenerator(),
    });
    expect(
      conflictingServices.managedSkillInstallations.install(
        invocation({
          managedSkillId: deploy.id,
          managedSkillReleaseId: release.id,
        }),
      ),
    ).rejects.toMatchObject({
      code: "managed_skill_install_conflict",
      kind: "conflict",
    });
  });

  test("rejects control-resource cursors from another query scope", async () => {
    const services = makeControlResourceApiServices({
      database: makeDatabase(),
      generateId: idGenerator(),
    });
    const decodeDefinition = Schema.decodeUnknownSync(WorkflowDefinitionDocumentV1);
    for (const [name, slug] of [
      ["First", "first"],
      ["Second", "second"],
    ] as const) {
      await services.workflowDefinitions.create(
        invocation({
          definition: decodeDefinition({
            entryStepId: "done",
            name,
            schemaVersion: 1,
            slug,
            steps: [{ id: "done", type: "end" }],
          }),
        }),
      );
    }
    const page = await services.workflowDefinitions.list(
      invocation(undefined, { query: { limit: 1 } }),
    );

    expect(page.nextCursor).toBeTruthy();
    expect(
      services.managedSkillSources.list(
        invocation(undefined, { query: { cursor: page.nextCursor! } }),
      ),
    ).rejects.toMatchObject({ code: "invalid_cursor", kind: "invalid-input" });
  });

  test("requires explicit tenant grants for environment-scoped reads", async () => {
    const services = makeControlResourceApiServices({
      database: makeDatabase(),
      generateId: idGenerator(),
    });
    const request = invocation(undefined);
    expect(
      services.managedSkillInstallations.list({
        ...request,
        identity: {
          principalId: PRINCIPAL_ID,
          scopes: ["managed-skills:read"],
        },
      }),
    ).rejects.toMatchObject({
      code: "environment_scope_violation",
      kind: "forbidden",
    });
  });
});
