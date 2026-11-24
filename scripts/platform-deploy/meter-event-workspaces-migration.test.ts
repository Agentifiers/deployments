import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  DEFAULT_TABLE_NAMES,
  decodePlatformRecord,
  EnvironmentRecord,
  makeIdGenerator,
  OrganizationRecord,
  withCanonicalRecordKeys,
} from "@deployments-ai/db";
import { fakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import {
  migrateMeterEventWorkspaces,
  type MeterEventWorkspacesMigration,
} from "./meter-event-workspaces-migration.ts";

const ORGANIZATION_ID = "01J9ZQ5Y5V7Q8R3X2K4M6N8P0A";
const PROJECT_ID = "01J9ZQ5Y5V7Q8R3X2K4M6N8P0B";
const ENVIRONMENT_ID = "01J9ZQ5Y5V7Q8R3X2K4M6N8P0C";
const ARCHIVED_ENVIRONMENT_ID = "01J9ZQ5Y5V7Q8R3X2K4M6N8P0G";
const AT = "2026-09-01T00:00:00.000Z";
const WORKSPACE_ID = "01J9ZQ5Y5V7Q8R3X2K4M6N8P0D";
const RUN_ID = "01J9ZQ5Y5V7Q8R3X2K4M6N8P0E";
const COMPLETION_MARKER = {
  pk: "GLOBAL#deploy-migration",
  sk: "DEPLOY-MIGRATION#meter-event-workspaces",
};

type Item = Readonly<Record<string, unknown>>;

describe("meter event workspaces migration", () => {
  const ids = makeIdGenerator();

  async function installation() {
    const tables = { client: fakeDynamoDocumentClient().client, tableNames: DEFAULT_TABLE_NAMES };
    const { control, usage } = tables.tableNames;
    const send = tables.client.send.bind(tables.client);
    const sent: string[] = [];
    let beforeSend: ((command: object) => Promise<void>) | undefined;
    tables.client.send = (async (command: object) => {
      const hook = beforeSend;
      if (hook) await hook(command);
      sent.push(command.constructor.name);
      return send(command as never);
    }) as typeof tables.client.send;
    await send(new DeleteCommand({ Key: COMPLETION_MARKER, TableName: control }));
    await send(
      new PutCommand({
        Item: Schema.decodeUnknownSync(OrganizationRecord)(
          withCanonicalRecordKeys({
            data: {
              createdAt: AT,
              id: ORGANIZATION_ID,
              name: "Metered",
              slug: "metered",
              status: "active",
              updatedAt: AT,
              version: 1,
            },
            itemType: "organization" as const,
          }),
        ),
        TableName: control,
      }),
    );
    for (const [id, status] of [
      [ENVIRONMENT_ID, "active"],
      [ARCHIVED_ENVIRONMENT_ID, "archived"],
    ] as const) {
      await send(
        new PutCommand({
          Item: Schema.decodeUnknownSync(EnvironmentRecord)(
            withCanonicalRecordKeys({
              data: {
                createdAt: AT,
                id,
                kind: "production",
                name: id,
                organizationId: ORGANIZATION_ID,
                projectId: PROJECT_ID,
                slug: id.toLowerCase(),
                status,
                updatedAt: AT,
                version: 1,
              },
              itemType: "environment" as const,
            }),
          ),
          TableName: control,
        }),
      );
    }
    const put = async (item: Item) => {
      await send(new PutCommand({ Item: item, TableName: usage }));
      return item;
    };
    const stored = async (item: Item) =>
      (await send(new GetCommand({ Key: { pk: item.pk, sk: item.sk }, TableName: usage }))).Item;

    /** A meter event as the writer of `attribution` stored it, with no decode on the way in. */
    const meterEvent = (
      attribution: {
        readonly environmentId?: string;
        readonly observability?: { readonly workspaceId?: string };
        readonly workspaceId?: string;
      },
      dimensions: Item = { inputTokens: 7 },
    ): Item => {
      const id = ids.generate();
      return {
        ...withCanonicalRecordKeys({
          data: {
            dimensions,
            environmentId: attribution.environmentId ?? ENVIRONMENT_ID,
            id,
            idempotencyKey: `model-usage/${id}`,
            metric: "model_tokens",
            ...(attribution.observability
              ? {
                  observability: {
                    captureMode: "metadata-only",
                    runSpanId: "0123456789abcdef",
                    sessionId: "01J9ZQ5Y5V7Q8R3X2K4M6N8P0F",
                    traceId: "0123456789abcdef0123456789abcdef",
                    ...attribution.observability,
                  },
                }
              : {}),
            occurredAt: "2026-10-04T12:00:00.000Z",
            organizationId: ORGANIZATION_ID,
            projectId: PROJECT_ID,
            quantity: 7,
            ...(attribution.observability ? { runId: RUN_ID } : {}),
            source: "model-gateway",
            unit: "tokens",
            ...(attribution.workspaceId ? { workspaceId: attribution.workspaceId } : {}),
          },
          itemType: "meter-event" as const,
        }),
      };
    };
    const unattributed = (dimensions?: Item) =>
      put(meterEvent({ observability: { workspaceId: WORKSPACE_ID } }, dimensions));
    const completed = async () =>
      (await send(new GetCommand({ Key: COMPLETION_MARKER, TableName: control }))).Item !==
      undefined;
    return {
      completed,
      crashBefore: (matches: (command: object) => boolean) => {
        beforeSend = async (command) => {
          if (!matches(command)) return;
          beforeSend = undefined;
          throw new Error("deploy tool crashed");
        };
      },
      meterEvent,
      onSend: (hook: (command: object) => Promise<void>) => {
        beforeSend = hook;
      },
      put,
      send,
      sent,
      stored,
      tables,
      unattributed,
    };
  }

  const swept = (migration: MeterEventWorkspacesMigration) => {
    if (migration.kind !== "swept") throw new Error(`Expected a sweep, got ${migration.kind}.`);
    return { changed: migration.changed, fixed: migration.fixed };
  };

  test("names the run's workspace on unattributed meter events, which then decode", async () => {
    const { completed, put, meterEvent, stored, tables, unattributed } = await installation();
    const event = await unattributed();
    const funded = await unattributed({ funding: "organization", modelCredentialId: "cred-1" });
    const archived = await put(
      meterEvent({
        environmentId: ARCHIVED_ENVIRONMENT_ID,
        observability: { workspaceId: WORKSPACE_ID },
      }),
    );
    const decodedBefore = await Effect.runPromise(
      Effect.result(decodePlatformRecord(await stored(event))),
    );

    const result = await migrateMeterEventWorkspaces(tables);

    expect(decodedBefore._tag).toBe("Failure");
    expect(result).toEqual({ changed: 0, environments: 2, fixed: 3, kind: "swept", read: 3 });
    for (const item of [event, funded, archived]) {
      const after = await stored(item);
      expect(after).toEqual({
        ...item,
        data: { ...(item.data as Item), workspaceId: WORKSPACE_ID },
      });
      expect(await Effect.runPromise(decodePlatformRecord(after))).toMatchObject({
        data: { workspaceId: WORKSPACE_ID },
        itemType: "meter-event",
      });
    }
    expect(await completed()).toBe(true);
  });

  test("refuses to write an event that still does not decode once it names its workspace", async () => {
    const { completed, send, stored, tables, unattributed } = await installation();
    const invalid = await unattributed({ funding: "customer" });

    const failure = await migrateMeterEventWorkspaces(tables).then(
      () => undefined,
      (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)),
    );
    const after = [await stored(invalid), await completed()];
    await send(
      new DeleteCommand({
        Key: { pk: invalid.pk, sk: invalid.sk },
        TableName: tables.tableNames.usage,
      }),
    );

    expect(failure).toBe(
      `Meter event ${String(invalid.pk)} ${String(invalid.sk)} does not decode even once it names its run's workspace.`,
    );
    expect(after).toEqual([invalid, false]);
  });

  test("leaves attributed events, events outside a run, and other item types alone", async () => {
    const { meterEvent, put, stored, tables } = await installation();
    const untouched = [
      await put(
        meterEvent({ observability: { workspaceId: WORKSPACE_ID }, workspaceId: WORKSPACE_ID }),
      ),
      await put(meterEvent({ workspaceId: WORKSPACE_ID })),
      await put(meterEvent({})),
      await put(meterEvent({ observability: {} })),
      await put({
        ...withCanonicalRecordKeys({
          data: {
            bucket: "2026-10-04T12",
            environmentId: ENVIRONMENT_ID,
            metric: "model_tokens",
            observability: { workspaceId: WORKSPACE_ID },
            organizationId: ORGANIZATION_ID,
            projectId: PROJECT_ID,
            quantity: 7,
            shard: 0,
            unit: "tokens",
            updatedAt: "2026-10-04T12:00:00.000Z",
            version: 1,
          },
          itemType: "usage-counter-shard" as const,
        }),
      }),
    ];

    const result = await migrateMeterEventWorkspaces(tables);

    expect(swept(result)).toEqual({ changed: 0, fixed: 0 });
    for (const item of untouched) expect(await stored(item)).toEqual(item);
  });

  test("a rerun after a crash finishes the sweep and changes nothing already attributed", async () => {
    const { completed, crashBefore, stored, tables, unattributed } = await installation();
    const first = await unattributed();
    const second = await unattributed();
    let puts = 0;
    crashBefore((command) => command instanceof PutCommand && (puts += 1) === 2);

    const crashed = await migrateMeterEventWorkspaces(tables).then(
      () => "finished",
      () => "crashed",
    );
    const afterCrash = [await stored(first), await stored(second), await completed()];
    const rerun = await migrateMeterEventWorkspaces(tables);
    const attributed = [await stored(first), await stored(second)];
    await tables.client.send(
      new DeleteCommand({ Key: COMPLETION_MARKER, TableName: tables.tableNames.control }),
    );
    const again = await migrateMeterEventWorkspaces(tables);

    expect(crashed).toBe("crashed");
    expect(afterCrash).toEqual([
      { ...first, data: { ...(first.data as Item), workspaceId: WORKSPACE_ID } },
      second,
      false,
    ]);
    expect(swept(rerun)).toEqual({ changed: 0, fixed: 1 });
    expect(swept(again)).toEqual({ changed: 0, fixed: 0 });
    expect([await stored(first), await stored(second)]).toEqual(attributed);
  });

  test("once complete, a deploy reads only the completion marker", async () => {
    const { sent, tables, unattributed } = await installation();
    await unattributed();
    const first = await migrateMeterEventWorkspaces(tables);
    sent.length = 0;

    const second = await migrateMeterEventWorkspaces(tables);

    expect([first.kind, second.kind]).toEqual(["swept", "already-complete"]);
    expect(sent).toEqual(["GetCommand"]);
  });

  test("does not overwrite an event that changed between the scan and the write", async () => {
    const { completed, onSend, put, stored, tables, unattributed } = await installation();
    const event = await unattributed();
    const raced = {
      ...event,
      data: { ...(event.data as Item), dimensions: { inputTokens: 8 }, quantity: 8 },
    };
    onSend(async (command) => {
      if (!(command instanceof PutCommand)) return;
      onSend(async () => {});
      await put(raced);
    });

    const first = await migrateMeterEventWorkspaces(tables);
    const afterRace = [await stored(event), await completed()];
    const rerun = await migrateMeterEventWorkspaces(tables);

    expect(swept(first)).toEqual({ changed: 1, fixed: 0 });
    expect(afterRace).toEqual([raced, false]);
    expect(swept(rerun)).toEqual({ changed: 0, fixed: 1 });
    expect(await stored(event)).toEqual({
      ...raced,
      data: { ...raced.data, workspaceId: WORKSPACE_ID },
    });
    expect(await completed()).toBe(true);
  });
});
