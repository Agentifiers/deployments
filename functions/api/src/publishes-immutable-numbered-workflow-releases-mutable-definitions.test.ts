import { WorkflowDefinitionDocumentV1 } from "@deployments-ai/api-contract";
import {
  DatabaseError,
  Keys,
  Ulid,
  tableForItemType,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TableName,
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
  test("publishes immutable numbered workflow releases from mutable definitions", async () => {
    const transactionBatches: PlatformRecord[][] = [];
    const database = makeDatabase(transactionBatches);
    const services = makeControlResourceApiServices({
      database,
      generateId: idGenerator(),
      now: () => new Date("2026-07-25T12:00:00.000Z"),
    });
    const decodeDefinition = Schema.decodeUnknownSync(WorkflowDefinitionDocumentV1);
    const originalDocument = decodeDefinition({
      entryStepId: "prepare",
      name: "Release workflow",
      schemaVersion: 1,
      slug: "release-workflow",
      steps: [
        {
          agentDeploymentId: PRINCIPAL_ID,
          id: "prepare",
          next: "done",
          toolName: "release.prepare",
          type: "tool",
        },
        { id: "done", type: "end" },
      ],
    });
    const definition = await services.workflowDefinitions.create(
      invocation({ definition: originalDocument }),
    );
    const first = await services.workflowReleases.publish(
      invocation({ expectedDefinitionVersion: 0 }, { id: String(definition.id) }),
    );

    const updatedDocument = decodeDefinition({
      ...originalDocument,
      name: "Release workflow v2",
      steps: [
        {
          agentDeploymentId: PRINCIPAL_ID,
          id: "prepare",
          next: "verify",
          toolName: "release.prepare",
          type: "tool",
        },
        {
          agentDeploymentId: PRINCIPAL_ID,
          id: "verify",
          next: "done",
          toolName: "release.verify",
          type: "tool",
        },
        { id: "done", type: "end" },
      ],
    });
    const updated = await services.workflowDefinitions.update(
      invocation(
        { definition: updatedDocument, expectedVersion: 1 },
        { id: String(definition.id) },
      ),
    );
    const second = await services.workflowReleases.publish(
      invocation({ expectedDefinitionVersion: updated.version }, { id: String(definition.id) }),
    );
    expect(
      services.workflowReleases.publish(
        invocation({ expectedDefinitionVersion: updated.version }, { id: String(definition.id) }),
      ),
    ).rejects.toMatchObject({ code: "version_conflict", kind: "conflict" });
    const fetchedFirst = await services.workflowReleases.get(
      invocation(undefined, { id: String(first.id) }),
    );
    const archivedRelease = await services.workflowReleases.archive(
      invocation({ expectedVersion: first.version }, { id: String(first.id) }),
    );
    const currentDefinition = await services.workflowDefinitions.get(
      invocation(undefined, { id: String(definition.id) }),
    );
    const archivedDefinition = await services.workflowDefinitions.archive(
      invocation(
        { expectedVersion: currentDefinition.version },
        { id: String(currentDefinition.id) },
      ),
    );

    expect(first.releaseNumber).toBe(1);
    expect(second.releaseNumber).toBe(2);
    expect(second.contentHash).not.toBe(first.contentHash);
    expect(fetchedFirst.definition).toEqual(originalDocument);
    expect(archivedRelease.status).toBe("archived");
    expect(archivedDefinition.status).toBe("archived");
    expect(
      transactionBatches.some(
        (batch) =>
          batch.some((record) => record.itemType === "workflow-definition") &&
          batch.some(
            (record) =>
              record.itemType === "semantic-event" &&
              record.data.eventType === "workflow-definition.created",
          ),
      ),
    ).toBe(true);
    for (const eventType of [
      "workflow-definition.archived",
      "workflow-release.archived",
    ] as const) {
      expect(
        transactionBatches.some((batch) =>
          batch.some(
            (record) => record.itemType === "semantic-event" && record.data.eventType === eventType,
          ),
        ),
      ).toBe(true);
    }
    expect(
      transactionBatches.some(
        (batch) =>
          batch.some((record) => record.itemType === "workflow-release") &&
          batch.filter((record) => record.itemType === "semantic-event").length === 2,
      ),
    ).toBe(true);
    const conflictingServices = makeControlResourceApiServices({
      database: {
        ...database,
        transactWrite: () =>
          Promise.reject(
            new DatabaseError({
              cause: new Error("simulated concurrent write"),
              message: "Conditional write failed.",
              operation: "transact-write",
              reason: "conflict",
              table: "control",
            }),
          ),
      },
    });
    expect(
      conflictingServices.workflowReleases.archive(
        invocation({ expectedVersion: 0 }, { id: String(first.id) }),
      ),
    ).rejects.toMatchObject({ code: "version_conflict", kind: "conflict" });
  });

  test("fills parent-scoped release pages across unrelated records", async () => {
    const services = makeControlResourceApiServices({
      database: makeDatabase(),
      generateId: idGenerator(),
      now: () => new Date("2026-07-25T12:00:00.000Z"),
    });
    const decodeDefinition = Schema.decodeUnknownSync(WorkflowDefinitionDocumentV1);
    const document = (name: string, slug: string) =>
      decodeDefinition({
        entryStepId: "done",
        name,
        schemaVersion: 1,
        slug,
        steps: [{ id: "done", type: "end" }],
      });
    const firstDefinition = await services.workflowDefinitions.create(
      invocation({ definition: document("First", "first") }),
    );
    const firstRelease = await services.workflowReleases.publish(
      invocation({ expectedDefinitionVersion: 0 }, { id: String(firstDefinition.id) }),
    );
    for (let index = 0; index < 100; index++) {
      const unrelatedDefinition = await services.workflowDefinitions.create(
        invocation({
          definition: document(`Unrelated ${index}`, `unrelated-${index}`),
        }),
      );
      await services.workflowReleases.publish(
        invocation({ expectedDefinitionVersion: 0 }, { id: String(unrelatedDefinition.id) }),
      );
    }
    const secondDefinition = await services.workflowDefinitions.create(
      invocation({ definition: document("Second", "second") }),
    );
    const secondRelease = await services.workflowReleases.publish(
      invocation({ expectedDefinitionVersion: 0 }, { id: String(secondDefinition.id) }),
    );

    const page = await services.workflowReleases.list(
      invocation(undefined, { id: String(secondDefinition.id), query: { limit: 1 } }),
    );
    const firstDefinitionPage = await services.workflowReleases.list(
      invocation(undefined, { id: String(firstDefinition.id), query: { limit: 1 } }),
    );

    expect(page.items.map((release) => release.id)).toEqual([secondRelease.id]);
    expect(page.items).not.toContainEqual(firstRelease);
    expect(firstDefinitionPage.nextCursor).toBeTruthy();
    expect(
      services.workflowReleases.list(
        invocation(undefined, {
          id: String(secondDefinition.id),
          query: { cursor: firstDefinitionPage.nextCursor!, limit: 1 },
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_cursor", kind: "invalid-input" });
  });

  test("bounds sparse parent-list scans and resumes after the scan budget", async () => {
    const baseDatabase = makeDatabase();
    let releaseQueries = 0;
    const database: DynamoDatabaseService = {
      ...baseDatabase,
      queryRecords: (table, input) => {
        const values = input.ExpressionAttributeValues as Record<string, unknown>;
        if (values[":prefix"] === "WORKFLOW-RELEASE#") {
          releaseQueries += 1;
          return baseDatabase.queryRecords(table, { ...input, Limit: 1 });
        }
        return baseDatabase.queryRecords(table, input);
      },
    };
    const services = makeControlResourceApiServices({
      database,
      generateId: idGenerator(),
      now: () => new Date("2026-07-25T12:00:00.000Z"),
    });
    const decodeDefinition = Schema.decodeUnknownSync(WorkflowDefinitionDocumentV1);
    const document = (name: string, slug: string) =>
      decodeDefinition({
        entryStepId: "done",
        name,
        schemaVersion: 1,
        slug,
        steps: [{ id: "done", type: "end" }],
      });
    for (let index = 0; index < 10; index++) {
      const unrelatedDefinition = await services.workflowDefinitions.create(
        invocation({
          definition: document(`Sparse unrelated ${index}`, `sparse-unrelated-${index}`),
        }),
      );
      await services.workflowReleases.publish(
        invocation({ expectedDefinitionVersion: 0 }, { id: String(unrelatedDefinition.id) }),
      );
    }
    const targetDefinition = await services.workflowDefinitions.create(
      invocation({ definition: document("Sparse target", "sparse-target") }),
    );
    const targetRelease = await services.workflowReleases.publish(
      invocation({ expectedDefinitionVersion: 0 }, { id: String(targetDefinition.id) }),
    );

    const first = await services.workflowReleases.list(
      invocation(undefined, { id: String(targetDefinition.id), query: { limit: 1 } }),
    );
    expect(first.items).toEqual([]);
    expect(first.nextCursor).toBeTruthy();
    expect(releaseQueries).toBe(10);

    const second = await services.workflowReleases.list(
      invocation(undefined, {
        id: String(targetDefinition.id),
        query: { cursor: first.nextCursor!, limit: 1 },
      }),
    );
    expect(second.items.map((release) => release.id)).toEqual([targetRelease.id]);
    expect(second.nextCursor).toBeNull();
    expect(releaseQueries).toBe(11);
  });

  test("clears nullable managed-skill source fields explicitly", async () => {
    const services = makeControlResourceApiServices({
      database: makeDatabase(),
      generateId: idGenerator(),
      now: () => new Date("2026-07-25T12:00:00.000Z"),
    });
    const source = await services.managedSkillSources.create(
      invocation({
        key: "clearable-source",
        licenseHash: `sha256:${"a".repeat(64)}`,
        metadata: { channel: "stable" },
        name: "Clearable source",
        pinnedCommit: "b".repeat(40),
        repositoryUrl: "https://github.com/example/clearable-source",
      }),
    );

    const updated = await services.managedSkillSources.update(
      invocation(
        {
          expectedVersion: 0,
          licenseHash: null,
          metadata: null,
          pinnedCommit: null,
          repositoryUrl: null,
        },
        { id: String(source.id) },
      ),
    );

    expect(updated).toMatchObject({ id: source.id, name: source.name, version: 1 });
    expect(updated).not.toHaveProperty("licenseHash");
    expect(updated).not.toHaveProperty("metadata");
    expect(updated).not.toHaveProperty("pinnedCommit");
    expect(updated).not.toHaveProperty("repositoryUrl");
  });
});
