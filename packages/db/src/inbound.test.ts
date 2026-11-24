import { describe, expect, test } from "bun:test";

import type { DynamoDatabaseService } from "./client-types.ts";
import type { Ulid } from "./ids.ts";
import { makeInboundPersistence, type InboundThreadRouteInput } from "./inbound.ts";
import { tableForItemType, type PlatformRecord } from "./records/index.ts";

const id = (suffix: string) => `01ARZ3NDEKTSV4RRFFQ69G${suffix.padStart(4, "0")}` as Ulid;

const routeInput: InboundThreadRouteInput = {
  agentDeploymentId: id("6"),
  channel: "telegram",
  createdAt: "2026-07-25T12:00:00.000Z",
  environmentId: id("2"),
  externalChannelId: "bot-1",
  externalThreadKey: "chat-1",
  externalWorkspaceId: "bot-1",
  organizationId: id("3"),
  projectId: id("4"),
  provider: "telegram",
  sourceId: id("1"),
  sourceKind: "channel-binding",
};

const notImplemented = () => Promise.reject(new Error("not implemented"));

function routeStore() {
  const records = new Map<string, PlatformRecord>();
  let initialReads = 0;
  const recordKey = (record: Pick<PlatformRecord, "pk" | "sk">) => `${record.pk}\u0000${record.sk}`;
  const database: DynamoDatabaseService = {
    deleteRecord: notImplemented,
    getRecord: async (_table, key) => {
      initialReads += 1;
      if (initialReads <= 2) return undefined;
      return records.get(`${key.pk}\u0000${key.sk}`);
    },
    putRecord: async (record, conditionExpression) => {
      expect(tableForItemType(record.itemType)).toBe("execution");
      expect(conditionExpression).toBe("attribute_not_exists(pk) AND attribute_not_exists(sk)");
      const key = recordKey(record);
      if (records.has(key)) throw new Error("ConditionalCheckFailedException");
      records.set(key, record);
    },
    queryRecords: notImplemented,
    transactWrite: notImplemented,
  };
  return { database, records };
}

describe("inbound persistence", () => {
  test("derives channel binding, deployment, release, and environment keys inside the DB package", async () => {
    const reads: Array<{ readonly pk: string; readonly sk: string }> = [];
    const database: DynamoDatabaseService = {
      deleteRecord: notImplemented,
      getRecord: async (_table, key) => {
        reads.push(key);
        return undefined;
      },
      putRecord: notImplemented,
      queryRecords: notImplemented,
      transactWrite: notImplemented,
    };
    const persistence = makeInboundPersistence({ database });
    const scope = {
      environmentId: routeInput.environmentId,
      organizationId: routeInput.organizationId,
    };

    await persistence.loadChannelBinding(scope, routeInput.sourceId);
    await persistence.loadAgentDeployment(scope, routeInput.agentDeploymentId);
    await persistence.loadAgentRelease(scope, routeInput.sourceId);
    await persistence.loadEnvironment({
      ...scope,
      projectId: routeInput.projectId,
    });

    expect(reads).toEqual([
      {
        pk: `ORG#${routeInput.organizationId}#ENV#${routeInput.environmentId}`,
        sk: `CHANNEL-BINDING#${routeInput.sourceId}`,
      },
      {
        pk: `ORG#${routeInput.organizationId}#ENV#${routeInput.environmentId}`,
        sk: `AGENT-DEPLOYMENT#${routeInput.agentDeploymentId}`,
      },
      {
        pk: `ORG#${routeInput.organizationId}#ENV#${routeInput.environmentId}`,
        sk: `AGENT-RELEASE#${routeInput.sourceId}`,
      },
      {
        pk: `ORG#${routeInput.organizationId}#PROJECT#${routeInput.projectId}`,
        sk: `ENVIRONMENT#${routeInput.environmentId}`,
      },
    ]);
  });

  test("concurrent first messages converge on the conditionally reserved thread", async () => {
    const store = routeStore();
    const generatedIds = [id("8"), id("9")];
    let generated = 0;
    const persistence = makeInboundPersistence({
      database: store.database,
      generateId: async () => generatedIds[generated++]!,
    });

    const threadIds = await Promise.all([
      persistence.reserveThreadRoute(routeInput),
      persistence.reserveThreadRoute(routeInput),
    ]);

    expect(new Set(threadIds).size).toBe(1);
    expect(generated).toBe(2);
    expect(store.records.size).toBe(1);
    const route = [...store.records.values()][0];
    expect(route).toMatchObject({
      data: {
        channel: "telegram",
        externalChannelId: "bot-1",
        externalThreadKey: "chat-1",
        externalWorkspaceId: "bot-1",
        provider: "telegram",
        sourceId: routeInput.sourceId,
        threadId: threadIds[0],
      },
      itemType: "inbound-thread-route",
    });
  });

  test("isolates equal thread keys across external channels and workspaces", async () => {
    const store = routeStore();
    const generatedIds = [id("8"), id("9")];
    let generated = 0;
    const persistence = makeInboundPersistence({
      database: store.database,
      generateId: async () => generatedIds[generated++]!,
    });

    const firstThreadId = await persistence.reserveThreadRoute(routeInput);
    const secondThreadId = await persistence.reserveThreadRoute({
      ...routeInput,
      externalChannelId: "bot-2",
      externalWorkspaceId: "workspace-2",
    });

    expect(firstThreadId).not.toBe(secondThreadId);
    expect(store.records.size).toBe(2);
  });
});
